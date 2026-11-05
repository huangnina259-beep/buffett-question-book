#!/usr/bin/env python3
"""Loopback-only application server. Run from a trusted local terminal."""
from __future__ import annotations
import argparse, base64, codecs, concurrent.futures, hashlib, json, mimetypes, re, secrets, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from engine import Engine

HERE=Path(__file__).resolve().parent

def raw_html_charset(data):
    """Choose an HTTP charset for archived bytes without rewriting the source."""
    try:
        data.decode('utf-8')
        return 'utf-8'
    except UnicodeDecodeError:
        pass
    declared=re.search(rb'<meta\b[^>]*\bcharset\s*=\s*[\"\']?\s*([A-Za-z0-9._-]+)',
                       data[:65536],re.I)
    if declared:
        try:
            encoding=codecs.lookup(declared.group(1).decode('ascii')).name
            # Restrict declarations to ordinary browser text encodings, excluding
            # Python-specific transforms such as unicode_escape or UTF-7.
            supported=(encoding.startswith('iso8859-') or re.fullmatch(r'cp125[0-8]',encoding)
                       or encoding in {'utf-8','ascii','cp874','koi8-r','koi8-u','shift_jis',
                                       'euc_jp','euc_kr','gb2312','gbk','gb18030','big5'})
            if supported:
                data.decode(encoding)
                if encoding in {'ascii','iso8859-1'}: return 'windows-1252'
                if encoding.startswith('cp125'): return 'windows-'+encoding[2:]
                return encoding.replace('iso8859-','iso-8859-').replace('_','-')
        except (LookupError,UnicodeError):
            pass
    return 'windows-1252'

def default_library():
    for candidate in [HERE.parent/'巴菲特知识库', HERE.parents[1]/'outputs/巴菲特知识库']:
        if (candidate/'原文知识库.sqlite').is_file():return candidate
    raise FileNotFoundError('Keep this application beside the complete 巴菲特知识库 folder, or use --library.')

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=8795)
    parser.add_argument('--library',type=Path);parser.add_argument('--runtime',type=Path,default=HERE/'runtime')
    args=parser.parse_args(); library=(args.library or default_library()).resolve()
    engine=Engine(library,args.runtime); ready,message=engine.provider.status()
    token=secrets.token_urlsafe(32);jobs={};lock=threading.Lock();pool=concurrent.futures.ThreadPoolExecutor(max_workers=1)
    def work(jid,payload):
        def progress(stage,msg):
            with lock: jobs[jid].update(status=stage,message=msg)
        try:
            result=engine.answer(payload['question'],payload.get('history',[]),progress=progress)
            with lock:jobs[jid].update(status='complete',message='Answer ready.',result=result)
        except Exception as e:
            # Do not return subprocess logs, credentials or local stack traces to a browser.
            safe=str(e) if isinstance(e,ValueError) or e.__class__.__name__=='ProviderError' else 'The local answer service encountered an error. No answer was released.'
            with lock:jobs[jid].update(status='error',message=safe,error=safe)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def host_ok(self):return self.headers.get('Host') in (f'127.0.0.1:{args.port}',f'localhost:{args.port}')
        def headers_out(self,status,ctype,csp=None):
            self.send_response(status);self.send_header('Content-Type',ctype);self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer')
            self.send_header('Content-Security-Policy',csp or "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        def send_json(self,status,data):
            body=json.dumps(data,ensure_ascii=False).encode();self.headers_out(status,'application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            if not self.host_ok():return self.send_json(403,{'error':'Invalid local host.'})
            path=urlsplit(self.path).path
            if path=='/api/status':
                return self.send_json(200,{'app':'buffett_questions','ready':ready,'provider':engine.provider.name,'message':message,'csrf_token':token,
                                          'scope':'English experimental answers from the local original-source library; no current-market data.'})
            if path.startswith('/api/jobs/'):
                with lock:item=jobs.get(path.rsplit('/',1)[-1]); snapshot=dict(item) if item else None
                return self.send_json(200 if snapshot else 404,snapshot or {'error':'This session has expired. Ask the question again.'})
            if path.startswith('/library/'):
                base=library;rel=unquote(path[len('/library/'):])
            else:base=HERE/'web';rel=unquote(path).lstrip('/') or 'index.html'
            target=(base/rel).resolve()
            if not target.is_relative_to(base.resolve()) or not target.is_file() or target.suffix.lower() not in {'.html','.css','.js','.json','.jsonl','.pdf','.txt','.md','.png','.jpg','.svg','.sqlite'}:
                return self.send_json(404,{'error':'File not found.'})
            data=target.read_bytes();ctype=mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
            csp=None;charset='utf-8'
            if base==library and target.suffix.lower()=='.html':
                resolved_relative=target.relative_to(library).as_posix()
                if resolved_relative.startswith(('reader/','qa-pilot/','reviewed-core/','readability/')) or resolved_relative=='speech-coverage.html':
                    # Permit only the exact inline code already shipped in generated library pages.
                    html=data.decode('utf-8','replace'); hashes={}
                    for tag in ['script','style']:
                        hashes[tag]=' '.join("'sha256-"+base64.b64encode(hashlib.sha256(t.encode()).digest()).decode()+"'" for t in re.findall(r'<'+tag+r'\b[^>]*>(.*?)</'+tag+r'>',html,re.S|re.I) if t.strip())
                    csp="default-src 'self'; script-src 'self' "+hashes['script']+"; style-src 'self' "+hashes['style']+"; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
                else:
                    charset=raw_html_charset(data)
                    csp="sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'"
            self.headers_out(200,ctype+('; charset='+charset if ctype.startswith('text/') else ''),csp)
            self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def do_POST(self):
            origin=self.headers.get('Origin')
            if not self.host_ok() or origin not in (f'http://127.0.0.1:{args.port}',f'http://localhost:{args.port}') or not secrets.compare_digest(self.headers.get('X-QA-Token',''),token):
                return self.send_json(403,{'error':'Open the local app in this browser before asking a question.'})
            if urlsplit(self.path).path!='/api/questions':return self.send_json(404,{'error':'Unknown endpoint.'})
            if not ready:return self.send_json(503,{'error':message})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=40000:raise ValueError('Question payload is too large.')
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict) or not isinstance(payload.get('question'),str) or not 3<=len(payload['question'].strip())<=2000:raise ValueError('Enter a question between 3 and 2,000 characters.')
                if not isinstance(payload.get('history',[]),list):raise ValueError('Invalid conversation history.')
            except (ValueError,TypeError):return self.send_json(400,{'error':'Enter a valid question of 3–2,000 characters.'})
            with lock:
                if sum(x['status'] not in ('complete','error') for x in jobs.values())>=2:return self.send_json(429,{'error':'The local reader is busy. Wait for the current answer.'})
                jid=secrets.token_urlsafe(18);jobs[jid]={'status':'queued','message':'Waiting for the local reader.'}
                # Keep only a small in-memory history; questions are not written to disk by this server.
                for old in list(jobs)[:-24]:
                    if jobs[old]['status'] in ('complete','error'):jobs.pop(old,None)
            pool.submit(work,jid,payload);self.send_json(202,{'job_id':jid})
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'Local: http://127.0.0.1:{args.port}',flush=True)
    print(message+' Close this terminal or press Ctrl+C to stop.',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        server.server_close()
        try: engine.provider.close()
        finally: pool.shutdown(wait=False,cancel_futures=True)
if __name__=='__main__':main()

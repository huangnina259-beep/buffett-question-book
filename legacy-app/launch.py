#!/usr/bin/env python3
"""Start the local reader without installing services or changing user settings."""
from __future__ import annotations
import json, signal, socket, subprocess, sys, time, urllib.request, webbrowser
from pathlib import Path

HERE=Path(__file__).resolve().parent

def status(port):
    try:
        # A loopback health check must not travel through a configured web proxy.
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:%s/api/status'%port, timeout=2) as response:
            data=json.load(response)
        return data if isinstance(data,dict) and data.get('app')=='buffett_questions' else None
    except (OSError,ValueError): return None

def choose_port():
    for port in range(8795,8806):
        if status(port): return port,True
    for port in range(8795,8806):
        with socket.socket() as sock:
            try: sock.bind(('127.0.0.1',port))
            except OSError: continue
        return port,False
    raise RuntimeError('Ports 8795–8805 are busy. Close an earlier local reader and try again.')

def main():
    port,running=choose_port();url='http://127.0.0.1:%s/'%port
    if running:
        print('An existing Buffett Question Book is running at '+url,flush=True)
        webbrowser.open(url);return
    process=subprocess.Popen([sys.executable,'-B',str(HERE/'server.py'),'--port',str(port)],
                             cwd=HERE,start_new_session=True)
    try:
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError('The local service could not start. See the message above.')
            if status(port): break
            time.sleep(.5)
        else: raise RuntimeError('The local service did not become ready. Check Codex and the source folder.')
        print('\nKeep this Terminal window open. Press Ctrl+C here to stop.\n'+url,flush=True)
        webbrowser.open(url)
        process.wait()
    except KeyboardInterrupt: print('\nStopping the local reader…',flush=True)
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
            try: process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill();process.wait(timeout=5)

if __name__=='__main__':
    try: main()
    except Exception as exc:
        print('Unable to start: '+str(exc),file=sys.stderr)
        input('Press Return to close this window. ')
        sys.exit(1)

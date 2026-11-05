"""Small, local Codex CLI adapter. No credentials are read by this application."""
from __future__ import annotations
import json, os, re, shutil, signal, subprocess, tempfile, threading, time, urllib.request
from pathlib import Path

class ProviderError(RuntimeError):
    pass

class CodexProvider:
    name = 'Signed-in local Codex'
    def __init__(self, runtime):
        self.runtime = Path(runtime).resolve()
        self.runtime.mkdir(parents=True, exist_ok=True)
        self._process_lock = threading.Lock()
        self._active_processes = {}
        self._closed = False
        self.binary = shutil.which('codex')
        if not self.binary:
            bundled = Path('/Applications/ChatGPT.app/Contents/Resources/codex')
            if bundled.is_file(): self.binary = str(bundled)
        self.model = os.environ.get('BUFFETT_CODEX_MODEL','')
        if not self.model:
            config=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'config.toml'
            if config.is_file():
                match=re.search(r'^model\s*=\s*"([a-zA-Z0-9._-]+)"',config.read_text(),re.M)
                if match:self.model=match.group(1)

    def status(self):
        if not self.binary:
            return False, 'Codex is not installed. Install and sign in to Codex, then restart this local app.'
        try:
            r = subprocess.run([self.binary, 'login', 'status'], capture_output=True, text=True, timeout=12)
            return (r.returncode == 0, 'Uses your existing Codex account and its usage allowance.' if r.returncode == 0 else 'Sign in using codex login, then restart this app.')
        except (OSError, subprocess.TimeoutExpired):
            return False, 'The local Codex login check could not finish. Check Codex and restart this app.'

    def _check_open(self):
        with self._process_lock:
            if self._closed:
                raise ProviderError('The local answer service was stopped. No further model request was started.')

    def close(self):
        """Permanently stop this provider and terminate its active process groups.

        The worker owns stdout/stderr. Shutdown only waits on process exit so it
        never races another thread's communicate() while draining the pipes.
        """
        with self._process_lock:
            self._closed = True
            processes = list(self._active_processes.values())
        for proc in processes:
            if proc.poll() is not None:
                continue
            try: os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError: pass
        for proc in processes:
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: pass

    def complete(self, prompt, schema, timeout=240):
        self._check_open()
        if not self.binary: raise ProviderError('Codex is not installed.')
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix='call-', dir=self.runtime) as folder:
            schema_path = Path(folder)/'schema.json'
            schema_path.write_text(json.dumps(schema))
            cmd = [self.binary, 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only']
            if self.model:cmd += ['--model',self.model]
            # These flags apply only to this process. Personal configuration is not changed.
            for f in ['shell_tool','unified_exec','apps','browser_use','browser_use_external','computer_use','hooks','remote_plugin','plugins','skill_search','image_generation','multi_agent','goals','code_mode_host','view_image','sleep_tool','tool_suggest','in_app_browser','shell_snapshot']:
                cmd += ['--disable', f]
            settings = {'web_search':'disabled', 'approval_policy':'never', 'project_doc_max_bytes':0,
                        'sqlite_home':str(self.runtime), 'log_dir':str(self.runtime),
                        'model_reasoning_effort':'medium', 'history.persistence':'none'}
            for k,v in settings.items(): cmd += ['-c', k+'='+json.dumps(v)]
            cmd += ['--json','--output-schema',str(schema_path),'-']
            child_env=os.environ.copy()
            # Respect the computer's existing proxy configuration for this child only.
            for scheme,value in urllib.request.getproxies().items():
                if scheme in ('http','https') and value:
                    child_env.setdefault(scheme.upper()+'_PROXY',value)
            # Registration and the second closed check share a lock with close:
            # shutdown cannot miss a process created between the two operations.
            with self._process_lock:
                if self._closed:
                    raise ProviderError('The local answer service was stopped. No further model request was started.')
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, cwd=folder, env=child_env, start_new_session=True)
                self._active_processes[id(proc)] = proc
            try:
                try:
                    stdout, stderr = proc.communicate(prompt, timeout=timeout)
                except subprocess.TimeoutExpired:
                    try:os.killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError:pass
                    try:proc.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:os.killpg(proc.pid, signal.SIGKILL)
                        except ProcessLookupError:pass
                        proc.communicate(timeout=5)
                    raise ProviderError('The model took too long. No answer was released. Try a narrower question.')
            finally:
                with self._process_lock:
                    self._active_processes.pop(id(proc), None)
            self._check_open()
            if proc.returncode:
                lower = (stderr+' '+stdout).lower()
                if 'limit' in lower or 'quota' in lower:
                    raise ProviderError('The Codex usage limit was reached. Check your account allowance and try later.')
                if 'login' in lower or 'unauthorized' in lower:
                    raise ProviderError('Codex needs you to sign in again. Run codex login and restart the app.')
                raise ProviderError('The local model process could not finish. Check Codex permissions and network access. No answer was released.')
            messages, usage, types = [], {}, []
            for line in stdout.splitlines():
                try: event=json.loads(line)
                except ValueError: continue
                if event.get('type') == 'turn.completed': usage=event.get('usage', {})
                if event.get('type') == 'item.completed':
                    item=event.get('item', {}); typ=item.get('type'); types.append(typ)
                    if typ == 'agent_message': messages.append(item.get('text',''))
            if any(t not in ('agent_message','reasoning','error') for t in types):
                raise ProviderError('Unexpected model tool activity was detected. The response was withheld.')
            for message in reversed(messages):
                try: value=json.loads(message)
                except ValueError: continue
                return value, {'seconds':round(time.monotonic()-started,2),'usage':usage,'provider':self.name,
                               'model':self.model or 'Codex built-in default','reasoning_effort':'medium',
                               'tool_activity':False,'runtime_notification_count':types.count('error')}
            raise ProviderError('The model did not return a usable structured answer. No answer was released.')

#!/usr/bin/env python3
"""Independent launcher audit: mocks only, no browser or real model execution."""
from __future__ import annotations
import ast, contextlib, hashlib, importlib.util, io, json, os, shlex, signal
import subprocess, sys, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch, call

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
LAUNCH = HERE/'launch.py'
COMMAND = HERE/'Start Buffett Questions.command'
SERVER = HERE/'server.py'
INPUT_HASHES = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [LAUNCH, COMMAND, SERVER]}
spec = importlib.util.spec_from_file_location('qa_launcher_under_review', LAUNCH)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
wrapper = COMMAND.read_text()

def fake_python(path, label, compatible=True):
    path.write_text('#!'+sys.executable+'\nimport sys, json, os\n'
                    +'if len(sys.argv)>1 and sys.argv[1]=="-c": sys.exit('+('0' if compatible else '1')+')\n'
                    +'print(json.dumps({"selected":'+repr(label)+',"args":sys.argv[1:],"cwd":os.getcwd()}))\n')
    path.chmod(0o755)

def run_wrapper(folder, *, bundled=True, system=True, compatible=True, unchanged=False):
    """Use a temporary launcher target; never invoke the application server.

    The unchanged case runs the exact command bytes with an inert launch.py.
    Other cases replace only the bundle-path assignment and command lookup in
    the temporary shell copy to mock interpreter availability. HOME is unchanged.
    """
    folder.mkdir(parents=True, exist_ok=True)
    copy = folder/'Start Buffett Questions.command'
    inert = folder/'launch.py'
    inert.write_text('import sys,json,os\nprint(json.dumps({"executable":sys.executable,"args":sys.argv[1:],"cwd":os.getcwd()}))\n')
    code = wrapper
    if not unchanged:
        bundle_path = folder/'mock bundled python3'
        system_path = folder/'mock system python3'
        if bundled: fake_python(bundle_path, 'bundled', compatible)
        if system: fake_python(system_path, 'system', compatible)
        lines = code.splitlines()
        lines = ['bundled_python='+shlex.quote(str(bundle_path)) if line.startswith('bundled_python=') else line for line in lines]
        lookup = ('function command() {\n'
                  '  if [[ "$1" == "-v" && "$2" == "python3" ]]; then\n'
                  + ('    print -r -- '+shlex.quote(str(system_path))+'; return 0\n' if system else '    return 1\n')
                  + '  fi\n  return 1\n}\n')
        lines.insert(2, lookup)
        code = '\n'.join(lines)+'\n'
    copy.write_text(code); copy.chmod(0o755)
    return subprocess.run(['/bin/zsh', str(copy)], input='\n', text=True, capture_output=True, timeout=8)

class LauncherAudit(unittest.TestCase):
    def test_01_actual_wrapper_uses_installed_python_and_quoted_app_path(self):
        with tempfile.TemporaryDirectory(prefix='Buffett launcher review ') as temp:
            folder=Path(temp)/'app with spaces'
            result=run_wrapper(folder, unchanged=True)
            self.assertEqual(result.returncode,0,result.stderr)
            data=json.loads(result.stdout.strip())
            bundled=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
            if bundled.is_file() and os.access(bundled, os.X_OK):
                self.assertEqual(Path(data['executable']).resolve(), bundled.resolve())
            self.assertEqual(Path(data['cwd']).resolve(),folder.resolve())

    def test_02_wrapper_prefers_executable_bundle(self):
        with tempfile.TemporaryDirectory(prefix='qa-launch-') as temp:
            folder=Path(temp)/'app with spaces';r=run_wrapper(folder)
            self.assertEqual(r.returncode,0,r.stderr)
            d=json.loads(r.stdout.strip());self.assertEqual(d['selected'],'bundled')
            self.assertEqual(d['args'][0],'-B');self.assertEqual(Path(d['args'][1]).resolve(),(folder/'launch.py').resolve());self.assertEqual(Path(d['cwd']).resolve(),folder.resolve())

    def test_03_wrapper_falls_back_to_available_system_python(self):
        with tempfile.TemporaryDirectory(prefix='qa-launch-') as temp:
            r=run_wrapper(Path(temp)/'app',bundled=False)
            self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(json.loads(r.stdout)['selected'],'system')

    def test_04_wrapper_missing_python_fails_without_launching(self):
        with tempfile.TemporaryDirectory(prefix='qa-launch-') as temp:
            r=run_wrapper(Path(temp)/'app',bundled=False,system=False)
            self.assertEqual(r.returncode,1);self.assertIn('Python 3.9 or later',r.stdout);self.assertNotIn('"selected"',r.stdout)

    def test_05_wrapper_rejects_unsupported_python(self):
        with tempfile.TemporaryDirectory(prefix='qa-launch-') as temp:
            r=run_wrapper(Path(temp)/'app',compatible=False)
            self.assertEqual(r.returncode,1);self.assertIn('Python 3.9 or later',r.stdout);self.assertNotIn('"selected"',r.stdout)

    def mock_health(self, data):
        opener=MagicMock();opener.open.return_value=io.StringIO(json.dumps(data))
        return patch.object(launcher.urllib.request,'build_opener',return_value=opener),opener

    def test_06_status_accepts_only_app_marker_and_bypasses_proxy(self):
        patched,opener=self.mock_health({'app':'buffett_questions','ready':True})
        with patched as build:
            self.assertEqual(launcher.status(8795)['app'],'buffett_questions')
            self.assertEqual(build.call_args.args[0].proxies,{})
            opener.open.assert_called_once_with('http://127.0.0.1:8795/api/status',timeout=2)

    def test_07_status_rejects_unrelated_object(self):
        patched,_=self.mock_health({'app':'other_service','ready':True})
        with patched:self.assertIsNone(launcher.status(8795))

    def test_08_status_rejects_unrelated_json_array_without_crashing(self):
        patched,_=self.mock_health([])
        with patched:self.assertIsNone(launcher.status(8795))

    def test_09_status_rejects_unrelated_json_scalar_without_crashing(self):
        for data in [None,True,42,'hello']:
            with self.subTest(data=data):
                patched,_=self.mock_health(data)
                with patched:self.assertIsNone(launcher.status(8795))

    def test_10_status_handles_bad_json_and_network_error(self):
        opener=MagicMock();opener.open.return_value=io.StringIO('{broken')
        with patch.object(launcher.urllib.request,'build_opener',return_value=opener):self.assertIsNone(launcher.status(8795))
        opener.open.side_effect=OSError('mock connection refused')
        with patch.object(launcher.urllib.request,'build_opener',return_value=opener):self.assertIsNone(launcher.status(8795))

    def socket_mock(self,busy):
        factory=MagicMock();sock=factory.return_value.__enter__.return_value
        def bind(address):
            self.assertEqual(address[0],'127.0.0.1')
            if address[1] in busy:raise OSError('mock port in use')
        sock.bind.side_effect=bind
        return factory

    def test_11_reuses_existing_default_app(self):
        with patch.object(launcher,'status',side_effect=lambda p:{'app':'buffett_questions'} if p==8795 else None),patch.object(launcher.socket,'socket',self.socket_mock(set())):
            self.assertEqual(launcher.choose_port(),(8795,True))

    def test_12_reuses_existing_alternate_even_when_earlier_port_is_free(self):
        with patch.object(launcher,'status',side_effect=lambda p:{'app':'buffett_questions'} if p==8796 else None),patch.object(launcher.socket,'socket',self.socket_mock({8796})):
            self.assertEqual(launcher.choose_port(),(8796,True))

    def test_13_occupied_unrelated_default_uses_alternate(self):
        with patch.object(launcher,'status',return_value=None),patch.object(launcher.socket,'socket',self.socket_mock({8795})):
            self.assertEqual(launcher.choose_port(),(8796,False))

    def test_14_all_ports_busy_has_actionable_failure(self):
        with patch.object(launcher,'status',return_value=None),patch.object(launcher.socket,'socket',self.socket_mock(set(range(8795,8806)))):
            with self.assertRaisesRegex(RuntimeError,'8795.*8805.*busy'):launcher.choose_port()

    def test_15_reuse_does_not_spawn_or_stop_existing_server(self):
        with patch.object(launcher,'choose_port',return_value=(8796,True)),patch.object(launcher.subprocess,'Popen') as popen,patch.object(launcher.webbrowser,'open') as browser:
            launcher.main();popen.assert_not_called();browser.assert_called_once_with('http://127.0.0.1:8796/')

    def test_16_successful_start_uses_selected_interpreter_and_port(self):
        process=MagicMock();process.poll.side_effect=[None,0];process.wait.return_value=0
        with patch.object(launcher,'choose_port',return_value=(8796,False)),patch.object(launcher.subprocess,'Popen',return_value=process) as popen,patch.object(launcher,'status',return_value={'app':'buffett_questions'}),patch.object(launcher.webbrowser,'open') as browser:
            launcher.main()
        popen.assert_called_once_with([sys.executable,'-B',str(launcher.HERE/'server.py'),'--port','8796'],cwd=launcher.HERE,start_new_session=True)
        browser.assert_called_once_with('http://127.0.0.1:8796/');process.send_signal.assert_not_called()

    def test_17_startup_process_failure_does_not_open_browser(self):
        process=MagicMock();process.poll.return_value=2
        with patch.object(launcher,'choose_port',return_value=(8795,False)),patch.object(launcher.subprocess,'Popen',return_value=process),patch.object(launcher.webbrowser,'open') as browser:
            with self.assertRaisesRegex(RuntimeError,'could not start'):launcher.main()
        browser.assert_not_called();process.send_signal.assert_not_called()

    def test_18_startup_readiness_timeout_stops_created_server(self):
        process=MagicMock();process.poll.return_value=None;process.wait.return_value=0
        with patch.object(launcher,'choose_port',return_value=(8795,False)),patch.object(launcher.subprocess,'Popen',return_value=process),patch.object(launcher,'status',return_value=None),patch.object(launcher.time,'sleep') as sleep,patch.object(launcher.webbrowser,'open') as browser:
            with self.assertRaisesRegex(RuntimeError,'did not become ready'):launcher.main()
        self.assertEqual(sleep.call_count,60);browser.assert_not_called();process.send_signal.assert_called_once_with(signal.SIGINT);process.wait.assert_called_once_with(timeout=8)

    def test_19_ctrl_c_gracefully_stops_own_server(self):
        process=MagicMock();process.poll.return_value=None;process.wait.side_effect=[KeyboardInterrupt(),0]
        with patch.object(launcher,'choose_port',return_value=(8795,False)),patch.object(launcher.subprocess,'Popen',return_value=process),patch.object(launcher,'status',return_value={'app':'buffett_questions'}),patch.object(launcher.webbrowser,'open'):
            launcher.main()
        self.assertEqual(process.wait.call_args_list,[call(),call(timeout=8)]);process.send_signal.assert_called_once_with(signal.SIGINT);process.terminate.assert_not_called()

    def test_20_ctrl_c_escalates_with_bounded_waits(self):
        process=MagicMock();process.poll.return_value=None
        process.wait.side_effect=[KeyboardInterrupt(),subprocess.TimeoutExpired('mock',8),subprocess.TimeoutExpired('mock',5),0]
        with patch.object(launcher,'choose_port',return_value=(8795,False)),patch.object(launcher.subprocess,'Popen',return_value=process),patch.object(launcher,'status',return_value={'app':'buffett_questions'}),patch.object(launcher.webbrowser,'open'):
            launcher.main()
        self.assertEqual(process.wait.call_args_list,[call(),call(timeout=8),call(timeout=5),call(timeout=5)])
        process.send_signal.assert_called_once_with(signal.SIGINT);process.terminate.assert_called_once();process.kill.assert_called_once()

    def test_21_ctrl_c_during_startup_stops_own_server(self):
        process=MagicMock();process.poll.return_value=None;process.wait.return_value=0
        with patch.object(launcher,'choose_port',return_value=(8795,False)),patch.object(launcher.subprocess,'Popen',return_value=process),patch.object(launcher,'status',side_effect=KeyboardInterrupt()),patch.object(launcher.webbrowser,'open') as browser:
            launcher.main()
        browser.assert_not_called();process.send_signal.assert_called_once_with(signal.SIGINT);process.wait.assert_called_once_with(timeout=8)

    def default_library(self,folder):
        tree=ast.parse(SERVER.read_text());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='default_library')
        env={'HERE':folder};exec(compile(ast.Module(body=[function],type_ignores=[]),str(SERVER),'exec'),env)
        return env['default_library']()

    def test_22_output_layout_uses_complete_sibling_library(self):
        with tempfile.TemporaryDirectory(prefix='qa-layout-') as temp:
            app=Path(temp)/'outputs'/'Buffett Questions';app.mkdir(parents=True)
            library=app.parent/'巴菲特知识库';library.mkdir();(library/'原文知识库.sqlite').write_bytes(b'fixture')
            self.assertEqual(self.default_library(app),library)

    def test_23_work_layout_uses_repository_output_library(self):
        with tempfile.TemporaryDirectory(prefix='qa-layout-') as temp:
            app=Path(temp)/'work'/'qa_live';app.mkdir(parents=True)
            library=Path(temp)/'outputs'/'巴菲特知识库';library.mkdir(parents=True);(library/'原文知识库.sqlite').write_bytes(b'fixture')
            self.assertEqual(self.default_library(app),library)

    def test_24_missing_library_has_actionable_error(self):
        with tempfile.TemporaryDirectory(prefix='qa-layout-') as temp:
            app=Path(temp)/'outputs'/'Buffett Questions';app.mkdir(parents=True)
            with self.assertRaisesRegex(FileNotFoundError,'beside the complete.*or use --library'):self.default_library(app)

class RecordedResult(unittest.TextTestResult):
    def __init__(self,*args,**kwargs):super().__init__(*args,**kwargs);self.records=[]
    def addSuccess(self,test):super().addSuccess(test);self.records.append({'id':test._testMethodName,'status':'pass'})
    def addFailure(self,test,err):super().addFailure(test,err);self.records.append({'id':test._testMethodName,'status':'fail','detail':str(err[1])})
    def addError(self,test,err):super().addError(test,err);self.records.append({'id':test._testMethodName,'status':'error','detail':type(err[1]).__name__+': '+str(err[1])})
    def addSubTest(self,test,subtest,err):
        super().addSubTest(test,subtest,err)
        if err:self.records.append({'id':test._testMethodName,'subtest':str(subtest),'status':'error','detail':type(err[1]).__name__+': '+str(err[1])})

if __name__=='__main__':
    output=io.StringIO();suite=unittest.defaultTestLoader.loadTestsFromTestCase(LauncherAudit)
    with contextlib.redirect_stdout(output),contextlib.redirect_stderr(output):
        result=unittest.TextTestRunner(stream=output,verbosity=2,resultclass=RecordedResult,buffer=True).run(suite)
    failed={r['id'] for r in result.records if r['status']!='pass'}
    findings=[]
    if failed&{'test_08_status_rejects_unrelated_json_array_without_crashing','test_09_status_rejects_unrelated_json_scalar_without_crashing'}:
        findings.append({'id':'LAUNCH-01','severity':'medium','file':'work/qa_live/launch.py','function':'status',
          'issue':'A valid JSON response that is not an object causes AttributeError at data.get, so an unrelated service can abort the launcher rather than allowing another port.',
          'required_fix':'Treat non-dict JSON health responses as unrelated before reading app.'})
    if 'test_12_reuses_existing_alternate_even_when_earlier_port_is_free' in failed:
        findings.append({'id':'LAUNCH-02','severity':'medium','file':'work/qa_live/launch.py','function':'choose_port',
          'issue':'An existing correct app on an alternate port is missed if a preceding port is currently free; a second app is started.',
          'required_fix':'Search the candidate port range for matching running instances before selecting the first free port.'})
    report={'schema_version':'qa-live-independent-launcher-review-1.0','reviewed_at_utc':datetime.now(timezone.utc).isoformat(),
      'status':'pass_scoped_mock_review' if result.wasSuccessful() else 'fixes_required',
      'scope':'Independent launcher/wrapper and server default-library tests with mocked HTTP, sockets, processes, browser launch and sleep. No actual application server, model request or browser launched.',
      'input_files':[{'path':str(Path(p).relative_to(HERE.parents[1])),'sha256':h,'unchanged_during_tests':hashlib.sha256(Path(p).read_bytes()).hexdigest()==h} for p,h in INPUT_HASHES.items()],
      'tests_run':result.testsRun,'case_results':result.records,'findings':findings,
      'resolved_findings':([
        {'id':'LAUNCH-01','resolution':'Implementation owner added a dict guard before reading the app marker. Rechecked with unrelated array and scalar JSON fixtures.'},
        {'id':'LAUNCH-02','resolution':'Implementation owner scans all candidate ports for an existing app before looking for a free port. Rechecked existing app on 8796 while 8795 is free.'}
      ] if not findings else []),
      'shutdown_scope':'Own server process: SIGINT then up to 8 seconds, terminate then up to 5 seconds, kill then up to 5 seconds. Mock-observed waits, not a real-process timing or child-model cancellation measurement.',
      'python_choice_scope':'One exact-byte wrapper run with an inert temporary launch.py checks the installed interpreter and paths with spaces. Availability/version branches use a temporary shell copy with only bundle-path and command-lookup instrumentation; HOME and installed files remain unchanged.',
      'layout_scope':'Extracted actual server.default_library function tested with temporary sibling-output and repository-work layouts and missing-library fixture.',
      'no_product_files_modified':True,'no_browser_opened':True,'no_real_model_called':True,'heldout_material_accessed':False,
      'limits':['Real Finder double-click behavior, macOS permissions and browser opening are not tested here.','Port ownership can change after probing; no claim of race-free port reservation.','This test does not verify authentication, corpus retrieval, answer quality or model child-process termination.','Tests import launch.py and extract default_library only; provider or engine initialization is not executed.']}
    (HERE/'launcher-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'tests':result.testsRun,'findings':findings,'report':str(HERE/'launcher-review.json')}))
    if not result.wasSuccessful():print(output.getvalue())

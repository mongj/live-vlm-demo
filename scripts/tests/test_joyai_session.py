"""Lifecycle checks with fake PBS and SSH; no GPU job is submitted."""
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'joyai-session.py'


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        binaries = self.root / 'bin'
        binaries.mkdir()
        stub = '''#!/usr/bin/env python3
import json, os, signal, sys, time
from pathlib import Path
root = Path(os.environ['TEST_ROOT'])
name = Path(sys.argv[0]).name
if name == 'qsub':
    print('42.test')
elif name == 'qstat':
    state = (root / 'state').read_text()
    print(json.dumps({'Jobs': {'42.test': {'job_state': state, 'exec_host': 'cvml01/0'}}}))
elif name == 'qdel':
    (root / 'deleted').write_text(sys.argv[1])
elif name == 'curl':
    sys.exit(1 if (root / 'unhealthy').exists() else 0)
elif name == 'ssh' and '-NT' in sys.argv:
    if (root / 'fail-ssh').exists():
        sys.exit(1)
    (root / 'tunnel').write_text(str(os.getpid()))
    def stop(*_):
        (root / 'tunnel-stopped').touch()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    while True:
        time.sleep(.1)
'''
        for name in ['qsub', 'qstat', 'qdel', 'curl', 'ssh']:
            path = binaries / name
            path.write_text(stub)
            path.chmod(0o755)
        tail = binaries / 'tail'
        tail.write_text(
            '#!/usr/bin/env python3\nimport os\nfrom pathlib import Path\n'
            'Path(os.environ["TEST_ROOT"], "follower").write_text(str(os.getpid()))\n'
            f'os.execv({shutil.which("tail")!r}, ["tail", *os.sys.argv[1:]])\n'
        )
        tail.chmod(0o755)
        (self.root / 'state').write_text('R')
        self.env = {**os.environ, 'TEST_ROOT': str(self.root), 'PATH': str(binaries) + ':' + os.environ['PATH']}
        self.command = ['python3', '-u', str(SCRIPT), '--node', 'cvml01', '--script', 'fake.pbs', '--log', str(self.root / 'pbs.log'), '--poll', '.1', '--wait', '2']

    def launch(self):
        output = (self.root / 'output').open('w')
        self.addCleanup(output.close)
        proc = subprocess.Popen(self.command, env=self.env, stdout=output, stderr=output)
        def stop():
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
        self.addCleanup(stop)
        return proc

    def wait_for(self, name):
        for _ in range(100):
            if (self.root / name).exists():
                return
            time.sleep(.05)
        self.fail(f'Missing {name}; {(self.root / "session.log").read_text()}')

    def assert_deleted(self):
        self.assertEqual((self.root / 'deleted').read_text(), '42.test')
        if (self.root / 'follower').exists():
            with self.assertRaises(ProcessLookupError):
                os.kill(int((self.root / 'follower').read_text()), 0)

    def wait_for_output(self, text):
        for _ in range(200):
            if text in (self.root / 'output').read_text():
                return
            time.sleep(.05)
        self.fail(f'Output did not contain {text!r}')

    def test_log_output_append_and_recreation(self):
        logfile = self.root / 'webinfer.log'
        logfile.write_text('existing adapter output\n')
        proc = self.launch()
        self.wait_for_output('existing adapter output')
        with logfile.open('a') as stream:
            stream.write('new adapter output\n')
        self.wait_for_output('new adapter output')
        logfile.rename(self.root / 'webinfer.old')
        logfile.write_text('replacement adapter output\n')
        self.wait_for_output('replacement adapter output')
        proc.terminate()
        proc.wait(timeout=10)
        self.assert_deleted()

    def test_log_created_after_startup(self):
        proc = self.launch()
        self.wait_for('tunnel')
        (self.root / 'webinfer.log').write_text('late adapter output\n')
        self.wait_for_output('late adapter output')
        proc.terminate()
        proc.wait(timeout=10)
        self.assert_deleted()

    def test_hangup_cancels_job_and_stops_tunnel(self):
        proc = self.launch()
        self.wait_for('tunnel')
        proc.send_signal(signal.SIGHUP)
        proc.wait(timeout=10)
        self.assert_deleted()
        self.assertTrue((self.root / 'tunnel-stopped').exists())

    def test_job_completion_stops_tunnel(self):
        proc = self.launch()
        self.wait_for('tunnel')
        (self.root / 'state').write_text('F')
        proc.wait(timeout=10)
        self.assert_deleted()
        self.assertTrue((self.root / 'tunnel-stopped').exists())

    def test_tunnel_failure_cancels_job(self):
        (self.root / 'fail-ssh').touch()
        proc = self.launch()
        proc.wait(timeout=10)
        self.assert_deleted()

    def test_queued_job_cancelled_on_stop(self):
        (self.root / 'state').write_text('Q')
        proc = self.launch()
        self.wait_for('session.log')
        proc.terminate()
        proc.wait(timeout=10)
        self.assert_deleted()

    def test_readiness_timeout_cancels_both(self):
        (self.root / 'unhealthy').touch()
        proc = self.launch()
        proc.wait(timeout=10)
        self.assert_deleted()
        self.assertTrue((self.root / 'tunnel-stopped').exists())

    @unittest.skipUnless(os.environ.get('TEST_SCREEN') == '1', 'Requires permission to create screen session')
    def test_actual_screen_deletion_cleans_up(self):
        name = f'joyai-lifecycle-test-{os.getpid()}'
        subprocess.run(['screen', '-dmS', name, *self.command], env=self.env, check=True)
        self.addCleanup(lambda: subprocess.run(['screen', '-S', name, '-X', 'quit'], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        self.wait_for('tunnel')
        self.wait_for('follower')
        subprocess.run(['screen', '-S', name, '-X', 'quit'], env=self.env, check=True)
        self.wait_for('deleted')
        self.assert_deleted()
        self.assertTrue((self.root / 'tunnel-stopped').exists())


if __name__ == '__main__':
    unittest.main()

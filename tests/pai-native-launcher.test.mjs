import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { preparePaiLauncher } from '../scripts/prepare-pai-launcher.mjs';

const captureSource = `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
class Capture {
  static void Main(string[] args) {
    string target = Path.Combine(Environment.GetEnvironmentVariable("PAI_TEST_OUTPUT"), Process.GetCurrentProcess().Id + ".json");
    var data = new Dictionary<string, object> {
      { "args", args }, { "cwd", Directory.GetCurrentDirectory() },
      { "runAsNode", Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") }
    };
    File.WriteAllText(target + ".tmp", new JavaScriptSerializer().Serialize(data));
    File.Move(target + ".tmp", target);
  }
}`;

const shellExecuteSource = String.raw`using System;
using System.Diagnostics;
using System.Security.Principal;
using Microsoft.Win32;
class ShellExecuteReview {
  static int Main(string[] args) {
    try {
      string token = Guid.Parse(args[1]).ToString();
      string alias = "pai-review-" + token + ".exe";
      string keyName = @"Software\Microsoft\Windows\CurrentVersion\App Paths\" + alias;
      // Elevated ShellExecute does not resolve per-user App Paths. Exercise the
      // matching installer scope: machine for elevated runners, user otherwise.
      bool elevated = new WindowsPrincipal(WindowsIdentity.GetCurrent())
        .IsInRole(WindowsBuiltInRole.Administrator);
      RegistryKey scope = elevated ? Registry.LocalMachine : Registry.CurrentUser;
      if (args[0] == "register") {
        using (RegistryKey existing = scope.OpenSubKey(keyName)) {
          if (existing != null) throw new InvalidOperationException("Test registration already exists.");
        }
        using (RegistryKey key = scope.CreateSubKey(keyName)) {
          key.SetValue("PiTestToken", token);
          key.SetValue("", args[2]);
        }
        Console.WriteLine(scope.Name);
      } else if (args[0] == "launch") {
        ProcessStartInfo start = new ProcessStartInfo(alias);
        start.UseShellExecute = true;
        start.WorkingDirectory = args[2];
        start.WindowStyle = ProcessWindowStyle.Hidden;
        using (Process process = Process.Start(start)) {
          if (process != null && (!process.WaitForExit(10000) || process.ExitCode != 0))
            throw new InvalidOperationException("The test launcher did not exit successfully.");
        }
      } else if (args[0] == "cleanup") {
        using (RegistryKey key = scope.OpenSubKey(keyName)) {
          if (key == null) return 0;
          if (!String.Equals(key.GetValue("PiTestToken") as string, token, StringComparison.Ordinal))
            throw new InvalidOperationException("Refusing to delete a registry key not owned by this test.");
        }
        scope.DeleteSubKey(keyName);
        using (RegistryKey key = scope.OpenSubKey(keyName)) {
          if (key != null) throw new InvalidOperationException("Test registry cleanup failed.");
        }
      } else throw new ArgumentException("Unknown test operation.");
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.ToString());
      return 1;
    }
  }
}`;

async function captured(directory, count) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
    if (files.length === count) return files.map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
    await setTimeout(50);
  }
  assert.fail(`Expected ${count} harmless capture processes to finish.`);
}

test('native pai opens the current folder and supports repeated launches with safe arguments', { skip: process.platform !== 'win32' }, async (t) => {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'pi-pai-native-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), parent);
    // Windows keeps a just-exited capture exe briefly locked; retry deletion.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt >= 10) throw error;
        await setTimeout(250);
      }
    }
  });
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../scripts/pai-launcher.cs', import.meta.url), join(root, 'scripts', 'pai-launcher.cs'));
  const executable = preparePaiLauncher({ root });
  const installDirectory = join(root, 'installed 中文 & 100% !');
  const bin = join(installDirectory, 'bin');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, 'pai.exe');
  copyFileSync(executable, launcher);
  const source = join(root, 'capture.cs');
  writeFileSync(source, captureSource);
  const windowsDirectory = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map((framework) => join(windowsDirectory, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe')).find(existsSync);
  const compilation = spawnSync(compiler, [
    '/nologo', '/target:winexe', '/reference:System.Web.Extensions.dll',
    `/out:${join(installDirectory, 'Pi Desktop.exe')}`, source,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(compilation.status, 0, compilation.error?.message || compilation.stderr || compilation.stdout);

  const cwd = join(root, '项目 空格 & 100% ! (folder)');
  mkdirSync(cwd);
  const scenarios = [
    { name: 'current directory', args: [], cwd, expected: cwd },
    { name: 'explicit directory', args: [cwd], cwd: root, expected: cwd },
    { name: 'PowerShell-compatible option', args: ['-Cwd', cwd], cwd: root, expected: cwd },
    { name: 'long directory option', args: ['--cwd', cwd], cwd: root, expected: cwd },
    { name: 'equals directory option', args: ['--cwd=' + cwd], cwd: root, expected: cwd },
    { name: 'drive root trailing backslash', args: [parse(root).root], cwd: root, expected: parse(root).root },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      const output = join(root, 'capture-' + index);
      mkdirSync(output);
      const invocation = {
        cwd: scenario.cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000,
        env: { ...process.env, PAI_TEST_OUTPUT: output, ELECTRON_RUN_AS_NODE: '1' },
      };
      // Every call must launch a fresh process, even when the command is repeated.
      for (let launch = 0; launch < 2; launch++) {
        const result = spawnSync(launcher, scenario.args, invocation);
        assert.equal(result.status, 0, result.error?.message || result.stderr);
      }
      const results = await captured(output, 2);
      for (const result of results) {
        assert.deepEqual(result.args, ['--pai', '--cwd', scenario.expected]);
        assert.equal(result.cwd, scenario.expected);
        assert.equal(result.runAsNode, null);
      }
    });
  }

  await t.test('ShellExecute resolves an App Paths alias and forwards its working directory', async (t) => {
    const shellSource = join(root, 'shell-execute.cs');
    const shellHelper = join(root, 'shell-execute.exe');
    writeFileSync(shellSource, shellExecuteSource);
    const compilation = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${shellHelper}`, shellSource], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    });
    assert.equal(compilation.status, 0, compilation.error?.message || compilation.stderr || compilation.stdout);
    const output = join(root, 'capture-shell');
    mkdirSync(output);
    const token = randomUUID();
    const invoke = (operation, ...args) => spawnSync(shellHelper, [operation, token, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000,
      env: { ...process.env, PAI_TEST_OUTPUT: output, ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      const registration = invoke('register', launcher);
      assert.equal(registration.status, 0, registration.error?.message || registration.stderr);
      assert.match(registration.stdout.trim(), /^HKEY_(CURRENT_USER|LOCAL_MACHINE)$/);
      t.diagnostic(`ShellExecute App Paths scope: ${registration.stdout.trim()}`);
      const result = invoke('launch', cwd);
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      const [capture] = await captured(output, 1);
      assert.deepEqual(capture.args, ['--pai', '--cwd', cwd]);
      assert.equal(capture.cwd, cwd);
      assert.equal(capture.runAsNode, null);
    } finally {
      // The helper only deletes its UUID-named key when PiTestToken matches.
      // The user's actual pai.exe registration is never read or written.
      const cleanup = invoke('cleanup');
      assert.equal(cleanup.status, 0, cleanup.error?.message || cleanup.stderr);
    }
  });

  await t.test('builds a launcher for a configured executable filename', async () => {
    const executableName = 'Pi Desktop Debug 中文 $&.exe';
    copyFileSync(join(installDirectory, 'Pi Desktop.exe'), join(installDirectory, executableName));
    copyFileSync(preparePaiLauncher({ root, executableName }), launcher);
    const output = join(root, 'capture-custom');
    mkdirSync(output);
    const result = spawnSync(launcher, [], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000,
      env: { ...process.env, PAI_TEST_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.deepEqual((await captured(output, 1))[0].args, ['--pai', '--cwd', cwd]);
    assert.equal(existsSync(join(root, 'packages', 'desktop', 'out', 'pai', 'pai-launcher.generated.cs')), false);
    for (const unsafe of ['../other.exe', '..\\other.exe', 'C:\\other.exe', 'bad"name.exe', 'bad\nname.exe']) {
      assert.throws(() => preparePaiLauncher({ root, executableName: unsafe }), /filename/);
    }
  });
});

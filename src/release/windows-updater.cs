using System;
using System.Diagnostics;
using System.IO;

internal static class WindowsUpdater {
    private static int Main() {
        string target = Environment.GetEnvironmentVariable("JINKRA_UPDATE_TARGET");
        string source = Environment.GetEnvironmentVariable("JINKRA_UPDATE_STAGED");
        string ready = Environment.GetEnvironmentVariable("JINKRA_UPDATE_READY");
        string error = Environment.GetEnvironmentVariable("JINKRA_UPDATE_ERROR");
        string folder = Path.GetDirectoryName(target);
        int result = 0;
        try {
            if (!File.Exists(target) || !File.Exists(source)) return 1;
            File.WriteAllText(ready, "ready");
            int pid = Int32.Parse(Environment.GetEnvironmentVariable("JINKRA_UPDATE_PARENT"));
            try {
                using (Process app = Process.GetProcessById(pid)) {
                    if (!app.WaitForExit(30000)) throw new IOException("小金同学尚未关闭。");
                }
            } catch (ArgumentException) { }
            var setup = new ProcessStartInfo(source, "--update") {
                WorkingDirectory = Path.GetDirectoryName(source), UseShellExecute = false, CreateNoWindow = true
            };
            setup.EnvironmentVariables["JINKRA_SETUP_DIRECTORY"] = folder;
            using (Process install = Process.Start(setup)) {
                install.WaitForExit();
                if (install.ExitCode != 0) throw new IOException("安装程序退出代码 " + install.ExitCode + "。");
            }
        } catch (Exception problem) {
            result = 1;
            try { File.WriteAllText(error, "更新未完成。" + problem.Message); } catch {}
        }

        try {
            string profile = Environment.GetEnvironmentVariable("JINKRA_UPDATE_PROFILE");
            string arguments = "";
            if (!String.IsNullOrEmpty(profile)) {
                int trailing = profile.Length - profile.TrimEnd('\\').Length;
                arguments = "\"--user-data-dir=" + profile + new String('\\', trailing) + "\"";
            }
            var launch = new ProcessStartInfo(target, arguments) {
                WorkingDirectory = folder, UseShellExecute = false
            };
            launch.EnvironmentVariables["JINKRA_UPDATE_CLEANUP"] = Path.GetDirectoryName(source);
            Process.Start(launch).Dispose();
        } catch (Exception problem) {
            try { File.WriteAllText(error, "无法重新打开小金同学。" + problem.Message); } catch {}
            result = 1;
        }
        return result;
    }
}

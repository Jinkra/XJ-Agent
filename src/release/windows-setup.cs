using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("小金同学安装程序")]
[assembly: AssemblyProduct("小金同学")]
[assembly: AssemblyCompany("Jinkra")]

internal sealed class AgentSetup : Form {
    private const int BrandWidth = 258;
    private const string ProductExe = "小金同学.exe";
    private const string Uninstaller = "Uninstall 小金同学.exe";
    private const string ShortcutName = "小金同学.lnk";
    private const string DesktopShortcutName = "小金工作台.lnk";
    // Names used before 1.9.0; upgrades must still find and replace them.
    private const string LegacyExe = "Jinkra Agent Legacy.exe";
    private const string LegacyUninstaller = "Uninstall Jinkra Agent Legacy.exe";
    private const string LegacyShortcutName = "Jinkra-Agent-Legacy.lnk";
    private const string InstallKey = @"Software\Jinkra\Agent";
    private static readonly Color Ink = Color.FromArgb(23, 44, 76);
    private static readonly Color Blue = Color.FromArgb(43, 91, 167);
    private static readonly Color Muted = Color.FromArgb(79, 100, 133);
    private static readonly Color Surface = Color.FromArgb(250, 252, 255);
    private readonly Image avatar;
    private readonly TextBox directory = new TextBox();
    private readonly Label headline;
    private readonly Label detail;
    private readonly Label status;
    private readonly Button browse;
    private readonly Button next;
    private readonly Button back;
    private readonly Button close;
    private readonly CheckBox desktopShortcut;
    private readonly CheckBox taskbarGuide;
    private readonly CheckBox quickLaunch;
    private readonly CheckBox keepData;
    private readonly bool removing;
    private readonly ProgressBar progress = new ProgressBar();
    private bool running;
    private bool complete;

    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wParam, IntPtr lParam);

    private AgentSetup(Image avatar, string uninstallDirectory = null) {
        this.avatar = avatar;
        removing = uninstallDirectory != null;
        Text = removing ? "小金同学 卸载向导" : "小金同学 安装向导";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(758, 518);
        BackColor = Surface;
        DoubleBuffered = true;
        Font = new Font("Microsoft YaHei UI", 10);
        using (GraphicsPath outline = Rounded(new RectangleF(0, 0, Width, Height), 24)) Region = new Region(outline);
        MouseDown += delegate(object sender, MouseEventArgs args) {
            if (args.Button == MouseButtons.Left && args.Y < 53) {
                ReleaseCapture();
                SendMessage(Handle, 0xa1, new IntPtr(2), IntPtr.Zero);
            }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs args) { if (running) args.Cancel = true; };

        headline = PlaceLabel(removing ? "卸载小金同学" : "安装小金同学", 300, 77, 410, 44, 23, Ink, FontStyle.Bold);
        detail = PlaceLabel(removing ? "将从这台电脑移除小金同学及其快捷方式。" : "选择小金同学的安装位置。",
            301, 127, 402, 28, 10, Muted, FontStyle.Regular);
        PlaceLabel("安装目录", 301, 177, 380, 23, 10, Ink, FontStyle.Bold);

        directory.SetBounds(316, 216, 291, 24);
        directory.BorderStyle = BorderStyle.None;
        directory.BackColor = Color.White;
        directory.ForeColor = Ink;
        directory.Text = uninstallDirectory ?? DefaultDirectory();
        directory.ReadOnly = removing;
        directory.AccessibleName = "安装目录";
        Controls.Add(directory);
        browse = PlaceButton("浏览…", 617, 204, 89, 42, false);
        browse.Click += ChooseFolder;

        desktopShortcut = PlaceChoice("创建桌面快捷方式", 262, true);
        taskbarGuide = PlaceChoice("安装后引导固定到任务栏", 291, false);
        quickLaunch = PlaceChoice("添加到快捷启动栏", 320, false);
        browse.Visible = desktopShortcut.Visible = taskbarGuide.Visible = quickLaunch.Visible = !removing;
        keepData = PlaceChoice("保留用户数据", 262, true);
        keepData.Visible = removing;
        status = PlaceLabel(removing ? "保留本地设置、日程和激活记录。" : "仅为当前 Windows 用户安装。",
            301, removing ? 302 : 361, 409, 48, 9, Muted, FontStyle.Regular);
        keepData.CheckedChanged += delegate {
            SetStatus(keepData.Checked ? "保留本地设置、日程和激活记录。" : "本地设置、日程和激活记录将被清除。", !keepData.Checked);
        };
        progress.SetBounds(302, 412, 404, 10);
        progress.Visible = false;
        progress.AccessibleName = "安装进度";
        Controls.Add(progress);

        back = PlaceButton("取消", 466, 448, 98, 43, false);
        back.Click += delegate { Close(); };
        next = PlaceButton(removing ? "卸载" : "立即安装", 577, 448, 129, 43, true);
        if (removing) {
            next.BackColor = Color.FromArgb(163, 52, 77);
            next.FlatAppearance.MouseOverBackColor = Color.FromArgb(145, 39, 64);
        }
        next.Click += delegate {
            if (removing) { if (complete) Close(); else BeginUninstall(); }
            else if (complete) OpenAgent();
            else BeginInstall();
        };
        close = PlaceButton("×", 699, 17, 40, 34, false);
        close.AccessibleName = "关闭安装向导";
        close.Click += delegate { Close(); };
        AcceptButton = removing ? back : next;
        CancelButton = back;
        if (SystemInformation.IsMenuAnimationEnabled) {
            Opacity = 0;
            var fade = new Timer { Interval = 16 };
            fade.Tick += delegate {
                Opacity = Math.Min(1, Opacity + 0.09);
                if (Opacity >= 1) fade.Dispose();
            };
            Shown += delegate { fade.Start(); };
        }
    }

    private Label PlaceLabel(string text, int x, int y, int width, int height, int size, Color color, FontStyle style) {
        var label = new Label { Text = text, ForeColor = color, Font = new Font("Microsoft YaHei UI", size, style) };
        label.SetBounds(x, y, width, height);
        Controls.Add(label);
        return label;
    }

    private Button PlaceButton(string text, int x, int y, int width, int height, bool primary) {
        var button = new Button {
            Text = text, FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Blue : Color.FromArgb(232, 239, 250),
            ForeColor = primary ? Color.White : Ink, UseVisualStyleBackColor = false,
            Cursor = Cursors.Hand
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(35, 77, 147) : Color.FromArgb(221, 231, 248);
        button.SetBounds(x, y, width, height);
        using (GraphicsPath shape = Rounded(new RectangleF(0, 0, width, height), 10)) button.Region = new Region(shape);
        Controls.Add(button);
        return button;
    }

    private CheckBox PlaceChoice(string text, int y, bool selected) {
        var choice = new CheckBox { Text = text, Checked = selected, ForeColor = Ink, Cursor = Cursors.Hand };
        choice.SetBounds(301, y, 405, 26);
        Controls.Add(choice);
        return choice;
    }

    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        using (var wash = new LinearGradientBrush(new Rectangle(0, 0, BrandWidth, Height), Color.FromArgb(230, 242, 255), Color.FromArgb(204, 224, 250), 110f)) {
            g.FillRectangle(wash, 0, 0, BrandWidth, Height);
        }
        using (var rings = new Pen(Color.FromArgb(145, 176, 206, 241), 1)) {
            for (int offset = 0; offset < 3; offset++) g.DrawEllipse(rings, -35 + offset * 12, 76 + offset * 12, 329 - offset * 24, 329 - offset * 24);
        }
        g.DrawImage(avatar, new RectangleF((BrandWidth - 159) / 2f, 127, 159, 159));
        using (var dark = new SolidBrush(Ink))
        using (var subtle = new SolidBrush(Muted))
        using (var display = new Font("Microsoft YaHei UI", 21, FontStyle.Bold))
        using (var small = new Font("Consolas", 11))
        using (var centered = new StringFormat { Alignment = StringAlignment.Center }) {
            g.DrawString("小金同学", display, dark, new RectangleF(0, 312, BrandWidth, 48), centered);
            g.DrawString("Windows x64", small, subtle, new RectangleF(0, 368, BrandWidth, 24), centered);
            string version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            g.DrawString("版本 " + version, small, subtle, new RectangleF(0, 402, BrandWidth, 24), centered);
        }
        using (GraphicsPath input = Rounded(new RectangleF(301, 204, 307, 42), 10))
        using (var border = new Pen(Color.FromArgb(198, 215, 239)))
        using (var white = new SolidBrush(Color.White)) {
            g.FillPath(white, input);
            g.DrawPath(border, input);
        }
    }

    private void ChooseFolder(object sender, EventArgs e) {
        using (var picker = new FolderBrowserDialog { Description = "选择小金同学的安装位置", ShowNewFolderButton = true }) {
            if (Directory.Exists(directory.Text)) picker.SelectedPath = directory.Text;
            if (picker.ShowDialog(this) == DialogResult.OK) {
                directory.Text = IsInstalled(picker.SelectedPath) ? picker.SelectedPath : Path.Combine(picker.SelectedPath, "Jinkra Agent");
            }
        }
    }

    private async void BeginInstall() {
        string target;
        try { target = ValidateDirectory(directory.Text, false); }
        catch (Exception error) { SetStatus(error.Message, true); return; }
        directory.Text = target;
        running = true;
        directory.Enabled = browse.Enabled = next.Enabled = back.Enabled = close.Enabled = false;
        desktopShortcut.Enabled = taskbarGuide.Enabled = quickLaunch.Enabled = false;
        bool desktop = desktopShortcut.Checked;
        bool quick = quickLaunch.Checked;
        headline.Text = "正在安装小金同学";
        detail.Text = "安装完成后可直接打开。";
        SetStatus("正在准备安装文件…", false);
        progress.Style = ProgressBarStyle.Continuous;
        progress.Value = 0;
        progress.Visible = true;
        var updates = new Progress<int>(percent => {
            if (percent < 0) {
                progress.Style = ProgressBarStyle.Marquee;
                SetStatus("正在写入程序文件和开始菜单快捷方式…", false);
            } else progress.Value = percent;
        });
        try {
            await Task.Run(() => Install(target, updates, desktop, quick, false));
            complete = true;
            headline.Text = "安装完成";
            detail.Text = "可以从开始菜单打开小金同学。";
            SetStatus(taskbarGuide.Checked ? "启动后，右键任务栏上的小金同学图标，选择「固定到任务栏」。" : "小金同学已安装到所选目录。", false);
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = 100;
            next.Text = "启动小金同学";
            back.Text = "完成";
        } catch (Exception error) {
            headline.Text = "安装未完成";
            detail.Text = "可以检查安装目录后重试。";
            SetStatus(error.Message, true);
            progress.Visible = false;
            directory.Enabled = browse.Enabled = true;
            desktopShortcut.Enabled = taskbarGuide.Enabled = quickLaunch.Enabled = true;
        } finally {
            running = false;
            next.Enabled = back.Enabled = close.Enabled = true;
        }
    }

    private void SetStatus(string message, bool error) {
        status.Text = message;
        status.ForeColor = error ? Color.FromArgb(157, 45, 72) : Muted;
    }

    private void OpenAgent() {
        try {
            string exe = Path.Combine(directory.Text, ProductExe);
            Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = directory.Text, UseShellExecute = false }).Dispose();
            if (taskbarGuide.Checked) next.Enabled = false;
            else Close();
        } catch (Exception error) { SetStatus("无法打开小金同学。" + error.Message, true); }
    }

    private async void BeginUninstall() {
        string target = directory.Text;
        bool keep = keepData.Checked;
        running = true;
        keepData.Enabled = back.Enabled = next.Enabled = close.Enabled = false;
        headline.Text = "正在卸载小金同学";
        detail.Text = "正在移除程序文件和快捷方式。";
        SetStatus(keep ? "将保留用户数据。" : "将清除用户数据。", false);
        progress.Style = ProgressBarStyle.Marquee;
        progress.Visible = true;
        try {
            await Task.Run(() => Uninstall(target, keep));
            complete = true;
            headline.Text = "卸载完成";
            detail.Text = "已移除小金同学。";
            string data = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            bool remaining = !keep && (Directory.Exists(Path.Combine(data, Path.GetFileNameWithoutExtension(ProductExe))) ||
                Directory.Exists(Path.Combine(data, "jinkra-companion")));
            SetStatus(keep ? "已保留用户数据。" : remaining ? "部分用户数据仍在，可能仍被程序占用。" : "已清除用户数据。", remaining);
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = 100;
            next.Text = "完成";
            next.BackColor = Blue;
            next.FlatAppearance.MouseOverBackColor = Color.FromArgb(35, 77, 147);
            back.Visible = false;
            AcceptButton = next;
        } catch (Exception error) {
            headline.Text = "卸载未完成";
            detail.Text = "可以关闭小金同学后重试。";
            SetStatus(error.Message, true);
            progress.Visible = false;
            keepData.Enabled = true;
        } finally {
            running = false;
            back.Enabled = next.Enabled = close.Enabled = true;
        }
    }

    private static void Uninstall(string directory, bool keepData) {
        string work = Path.Combine(Path.GetTempPath(), "jinkra-uninstall-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        string core = Path.Combine(work, "uninstall.exe");
        try {
            if (File.Exists(Path.Combine(directory, Uninstaller))) TryDelete(Path.Combine(directory, LegacyExe));
            File.Copy(Path.Combine(directory, File.Exists(Path.Combine(directory, Uninstaller)) ? Uninstaller : LegacyUninstaller), core);
            string options = keepData ? "/S" : "/S --delete-app-data";
            using (Process removal = Process.Start(new ProcessStartInfo(core, options + " _?=" + directory) {
                WorkingDirectory = work, UseShellExecute = false, CreateNoWindow = true
            })) {
                removal.WaitForExit();
                if (removal.ExitCode != 0 || File.Exists(Path.Combine(directory, ProductExe))) {
                    throw new IOException("无法完成卸载。请退出正在运行的小金同学。");
                }
            }
        } finally {
            try { File.Delete(core); Directory.Delete(work); } catch (IOException) {} catch (UnauthorizedAccessException) {}
        }
    }

    private static bool IsInstalled(string folder) {
        return (File.Exists(Path.Combine(folder, ProductExe)) && File.Exists(Path.Combine(folder, Uninstaller))) ||
            (File.Exists(Path.Combine(folder, LegacyExe)) && File.Exists(Path.Combine(folder, LegacyUninstaller)));
    }

    private static string DefaultDirectory() {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(InstallKey)) {
            string installed = key == null ? null : key.GetValue("InstallLocation") as string;
            if (!String.IsNullOrEmpty(installed) && IsInstalled(installed)) return installed;
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Jinkra Agent");
    }

    private static string ValidateDirectory(string input, bool update) {
        string value = input.Trim();
        if (value.Length < 4 || value[1] != ':' || (value[2] != '\\' && value[2] != '/')) {
            throw new IOException("请选择本机磁盘上的完整安装目录。");
        }
        string fullPath = Path.GetFullPath(value);
        string directory = fullPath.TrimEnd('\\');
        if (directory.Equals(Path.GetPathRoot(fullPath).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) {
            throw new IOException("请选择磁盘中的子目录。");
        }
        if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) {
            throw new IOException("请选择实际安装目录。");
        }
        bool installed = IsInstalled(directory);
        if (update && !installed) throw new IOException("无法定位已安装的小金同学。");
        if (!installed && Directory.Exists(directory) && Directory.GetFileSystemEntries(directory).Length != 0) {
            throw new IOException("请选择空目录，或小金同学现有的安装目录。");
        }
        return directory;
    }

    private static void Install(string directory, IProgress<int> progress, bool desktop, bool quick, bool update) {
        var shortcuts = new Dictionary<string, byte[]>();
        string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DesktopShortcutName);
        string quickLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            @"Microsoft\Internet Explorer\Quick Launch", ShortcutName);
        string target = Path.Combine(directory, ProductExe);
        string legacyTarget = Path.Combine(directory, LegacyExe);
        string legacyDesktop = Path.Combine(Path.GetDirectoryName(desktopLink), LegacyShortcutName);
        string legacyQuick = Path.Combine(Path.GetDirectoryName(quickLink), LegacyShortcutName);
        bool migrating = File.Exists(Path.Combine(directory, LegacyUninstaller));
        if (update) {
            foreach (string shortcut in new[] { desktopLink, quickLink }) {
                if (File.Exists(shortcut)) shortcuts.Add(shortcut, File.ReadAllBytes(shortcut));
            }
            desktop = shortcuts.ContainsKey(desktopLink) || (migrating && File.Exists(legacyDesktop));
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(InstallKey)) {
                string quickTarget = key == null ? null : key.GetValue("QuickLaunchTarget") as string;
                quick = (shortcuts.ContainsKey(quickLink) && String.Equals(quickTarget, target, StringComparison.OrdinalIgnoreCase)) ||
                    (migrating && File.Exists(legacyQuick) && String.Equals(quickTarget, legacyTarget, StringComparison.OrdinalIgnoreCase));
            }
        }
        string work = Path.Combine(Path.GetTempPath(), "jinkra-setup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        string payload = Path.Combine(work, "package.exe");
        try {
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("package.exe"))
            using (var file = new FileStream(payload, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] bytes = new byte[1024 * 1024];
                int received, last = -1;
                long total = 0;
                while ((received = source.Read(bytes, 0, bytes.Length)) != 0) {
                    file.Write(bytes, 0, received);
                    total += received;
                    int percent = (int)(total * 100 / source.Length);
                    if (progress != null && percent != last) { progress.Report(percent); last = percent; }
                }
            }
            if (progress != null) progress.Report(-1);
            string options = "/S";
            if (update) options += " --updated";
            if (!desktop) options += " --no-desktop-shortcut";
            if (quick) options += " /JINKRA_QUICK_LAUNCH";
            // NSIS requires /D to be the final argument and take the unquoted remainder of the command line.
            using (Process setup = Process.Start(new ProcessStartInfo(payload, options + " /D=" + directory) {
                WorkingDirectory = work, UseShellExecute = false, CreateNoWindow = true
            })) {
                setup.WaitForExit();
                if (setup.ExitCode != 0 || !File.Exists(target) || !File.Exists(Path.Combine(directory, Uninstaller))) {
                    throw new IOException("安装未完成。请关闭正在运行的小金同学并检查目录权限。");
                }
            }
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(InstallKey)) {
                key.SetValue("InstallLocation", directory);
                if (update && quick) key.SetValue("QuickLaunchTarget", target);
                else if (migrating) key.DeleteValue("QuickLaunchTarget", false);
            }
        } finally {
            try { File.Delete(payload); Directory.Delete(work); } catch (IOException) {} catch (UnauthorizedAccessException) {}
            foreach (var shortcut in shortcuts) {
                // Some NSIS upgrades remove an older shortcut even when its target is unchanged.
                if (File.Exists(shortcut.Key)) continue;
                using (var link = new FileStream(shortcut.Key, FileMode.CreateNew, FileAccess.Write)) {
                    link.Write(shortcut.Value, 0, shortcut.Value.Length);
                }
            }
        }
    }

    private static void TryDelete(string file) {
        try { if (File.Exists(file)) File.Delete(file); } catch (IOException) {} catch (UnauthorizedAccessException) {}
    }

    private static GraphicsPath Rounded(RectangleF bounds, float radius) {
        float diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    [STAThread]
    private static int Main(string[] args) {
        string uninstallDirectory = null;
        if (args.Length == 2 && args[0] == "--uninstall") {
            try { uninstallDirectory = ValidateDirectory(args[1], true); }
            catch { return 1; }
        }
        if (args.Length == 1 && (args[0] == "--update" || args[0] == "--silent")) {
            try {
                string location = Environment.GetEnvironmentVariable("JINKRA_SETUP_DIRECTORY") ?? DefaultDirectory();
                Install(ValidateDirectory(location, args[0] == "--update"), null, false, false, args[0] == "--update");
                return 0;
            } catch { return 1; }
        }
        SetCurrentProcessExplicitAppUserModelID(uninstallDirectory == null ? "Jinkra.Agent.Setup" : "Jinkra.Agent.Uninstall");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (Stream logo = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png"))
        using (Image avatar = Image.FromStream(logo))
        using (var setup = new AgentSetup(avatar, uninstallDirectory)) {
            Application.Run(setup);
            return setup.complete ? 0 : 2;
        }
    }
}

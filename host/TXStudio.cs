// TX Studio Windows host: a WebView2 window around the web UI in resources\app, providing
// the bridge the UI expects as window.api (host-bridge.js): dialogs, file access, folder
// watching, settings and theme. Built with the C# compiler that ships with .NET Framework
// 4.8 (C# 5), so it needs nothing beyond Windows 10/11 and the Edge WebView2 runtime.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

[assembly: AssemblyTitle("TX Studio")]
[assembly: AssemblyProduct("TX Studio")]
[assembly: AssemblyDescription("Thermomagnetic curve viewer with automatic empty-holder correction")]
[assembly: AssemblyVersion(TXStudio.Program.Version)]
[assembly: AssemblyFileVersion(TXStudio.Program.Version)]

namespace TXStudio
{
    static class Program
    {
        public const string Version = "0.7.4.0";

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(args));
        }
    }

    sealed class MainForm : Form
    {
        const string Host = "tx-studio.app";
        const int MaxDepth = 8, MaxEntries = 30000;
        static readonly Encoding Latin1 = Encoding.GetEncoding(28591);
        static readonly HashSet<string> SkipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "AppData", "@eaDir", "#recycle", ".snapshot", "__pycache__", "node_modules", ".venv", "venv",
            ".git", "$RECYCLE.BIN", "System Volume Information" };
        static readonly Regex DryDir = new Regex(@"holder|empty|dry[ _-]?run|blank", RegexOptions.IgnoreCase);
        static readonly Regex RunFile = new Regex(@"\.(cur|clw|kht|klt)$", RegexOptions.IgnoreCase);

        readonly string[] args;
        readonly string appDir;      // web UI (resources\app, or TXS_APPDIR for the source tree)
        readonly string dataDir;     // settings (%APPDATA%\TX Studio, same as before)
        readonly string script = Environment.GetEnvironmentVariable("TXS_SCRIPT");   // dev: scripted screenshots
        readonly HashSet<string> savedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1000 };
        readonly WebView2 web;
        FileSystemWatcher watcher;
        Timer watchTimer;
        string theme = "system";
        float scale = 1f;

        public MainForm(string[] args)
        {
            this.args = args;
            appDir = Env("TXS_APPDIR") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "resources", "app");
            dataDir = Env("TXS_USERDATA") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TX Studio");
            Text = "TX Studio";
            try { Icon = new Icon(Path.Combine(appDir, "src", "icon.ico")); } catch { }
            using (var g = CreateGraphics()) scale = g.DpiX / 96f;
            MinimumSize = new Size(S(960), S(600));
            StartPosition = FormStartPosition.Manual;

            var s = LoadSettings();
            theme = s.ContainsKey("theme") ? s["theme"] as string ?? "system" : "system";
            BackColor = IsDark() ? Color.FromArgb(17, 19, 23) : Color.White;
            ApplySavedBounds(s);

            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            Load += async (o, e) => { ApplyTitleBar(); await InitAsync(); };
            FormClosing += (o, e) => RememberBounds();
            SystemEvents.UserPreferenceChanged += (o, e) => { if (theme == "system" && IsHandleCreated) BeginInvoke(new Action(ApplyTitleBar)); };
        }

        static string Env(string name)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? null : v;
        }

        int S(double dip) { return (int)Math.Round(dip * scale); }

        // ------------------------------------------------------------------ window
        void ApplySavedBounds(Dictionary<string, object> s)
        {
            var area = Screen.PrimaryScreen.WorkingArea;
            var r = new Rectangle(0, 0, Math.Min(S(1440), area.Width), Math.Min(S(900), area.Height));
            r.Location = new Point(area.Left + (area.Width - r.Width) / 2, area.Top + (area.Height - r.Height) / 2);
            var b = s.ContainsKey("bounds") ? s["bounds"] as Dictionary<string, object> : null;
            if (b != null && b.ContainsKey("width") && b.ContainsKey("height"))
            {
                var saved = new Rectangle(S(Num(b, "x")), S(Num(b, "y")), S(Num(b, "width")), S(Num(b, "height")));
                if (Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(saved))) r = saved;
            }
            if (script != null) { r.Location = new Point(-20000, 0); ShowInTaskbar = false; }    // off-screen test runs
            Bounds = r;
            if (script == null && s.ContainsKey("maximized") && true.Equals(s["maximized"])) WindowState = FormWindowState.Maximized;
        }

        static double Num(Dictionary<string, object> d, string k)
        {
            try { return Convert.ToDouble(d[k]); } catch { return 0; }
        }

        void RememberBounds()
        {
            if (script != null) return;
            var s = LoadSettings();
            s["maximized"] = WindowState == FormWindowState.Maximized;
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            s["bounds"] = new Dictionary<string, object> {
                { "x", (int)(r.X / scale) }, { "y", (int)(r.Y / scale) },
                { "width", (int)(r.Width / scale) }, { "height", (int)(r.Height / scale) } };
            SaveSettings(s);
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        bool IsDark()
        {
            if (theme == "dark") return true;
            if (theme == "light") return false;
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    var v = k == null ? null : k.GetValue("AppsUseLightTheme");
                    return v is int && (int)v == 0;
                }
            }
            catch { return false; }
        }

        void ApplyTitleBar()
        {
            int on = IsDark() ? 1 : 0;
            DwmSetWindowAttribute(Handle, 20, ref on, 4);           // DWMWA_USE_IMMERSIVE_DARK_MODE
        }

        // ------------------------------------------------------------------ WebView2
        async Task InitAsync()
        {
            try
            {
                var cache = Env("TXS_USERDATA") != null ? Path.Combine(dataDir, "WebView2")
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TX Studio", "WebView2");
                var env = await CoreWebView2Environment.CreateAsync(null, cache);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception)
            {
                var answer = MessageBox.Show(this,
                    "TX Studio needs the Microsoft Edge WebView2 Runtime. It is part of Windows 11 and of up-to-date Windows 10, but it is missing on this PC.\n\nOpen the download page now?",
                    "TX Studio", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (answer == DialogResult.Yes) Process.Start("https://developer.microsoft.com/microsoft-edge/webview2/#download-section");
                Close();
                return;
            }
            var core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;   // F5, Ctrl+F, Ctrl+O ... belong to the app
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.AreDevToolsEnabled = Env("TXS_DEVTOOLS") != null;
            core.SetVirtualHostNameToFolderMapping(Host, appDir, CoreWebView2HostResourceAccessKind.Allow);
            core.Profile.PreferredColorScheme = SchemeFor(theme);
            core.WebMessageReceived += OnWebMessage;
            core.NavigationStarting += (o, e) => { if (!e.Uri.StartsWith("https://" + Host + "/")) e.Cancel = true; };
            core.NewWindowRequested += (o, e) => { e.Handled = true; OpenExternal(e.Uri); };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(Path.Combine(appDir, "src", "host-bridge.js")));
            if (script != null)
            {
                EventHandler<CoreWebView2NavigationCompletedEventArgs> once = null;
                once = async (o, e) => { core.NavigationCompleted -= once; await RunScript(); };
                core.NavigationCompleted += once;
            }
            core.Navigate("https://" + Host + "/src/index.html");
        }

        static CoreWebView2PreferredColorScheme SchemeFor(string t)
        {
            return t == "dark" ? CoreWebView2PreferredColorScheme.Dark
                : t == "light" ? CoreWebView2PreferredColorScheme.Light : CoreWebView2PreferredColorScheme.Auto;
        }

        static void OpenExternal(string uri)
        {
            if (uri != null && (uri.StartsWith("https://") || uri.StartsWith("http://"))) Process.Start(uri);
        }

        void Post(object payload)
        {
            if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(json.Serialize(payload));
        }

        // Take what is needed from the event and return at once: WebView2 must not be blocked
        // inside its own callback (a modal dialog there would stall the page).
        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            var raw = e.WebMessageAsJson;
            string droppedPath = null;
            try
            {
                if (e.AdditionalObjects != null)
                    foreach (var o in e.AdditionalObjects)
                    {
                        var f = o as CoreWebView2File;
                        if (f != null) { droppedPath = f.Path; break; }
                    }
            }
            catch { }
            BeginInvoke(new Action(() => HandleMessage(raw, droppedPath)));
        }

        async void HandleMessage(string raw, string droppedPath)
        {
            Dictionary<string, object> msg;
            try { msg = json.Deserialize<Dictionary<string, object>>(raw); }
            catch { return; }
            if (msg == null) return;
            object id = msg.ContainsKey("id") ? msg["id"] : null;
            string method = msg.ContainsKey("method") ? msg["method"] as string : null;
            object[] a = Arr(msg.ContainsKey("args") ? msg["args"] : null);
            object result = null;
            string error = null;
            try { result = method == "pathForFile" ? droppedPath : await Dispatch(method, a); }
            catch (Exception ex) { error = ex.Message; }
            Post(new Dictionary<string, object> { { "id", id }, { "result", result }, { "error", error } });
        }

        static object[] Arr(object o)
        {
            if (o is object[]) return (object[])o;
            var list = o as ArrayList;
            return list != null ? list.ToArray() : new object[0];
        }

        static string Str(object[] a, int i) { return a.Length > i ? a[i] as string : null; }

        Task<object> Dispatch(string method, object[] a)
        {
            switch (method)
            {
                case "pickFolder": return Done(PickFolder(Str(a, 0)));
                case "saveDialog": return Done(SaveDialog(a.Length > 0 ? a[0] as Dictionary<string, object> : null));
                case "exists": { var p = Str(a, 0); return Done(p != null && (File.Exists(p) || Directory.Exists(p))); }
                case "startupPath": return Done(StartupPath());
                case "scan": { var root = Str(a, 0); return Task.Run(() => (object)ScanTree(root)); }
                case "dryRunFiles": { var root = Str(a, 0); return Task.Run(() => (object)DryRunFiles(root)); }
                case "readTexts": { var paths = Arr(a.Length > 0 ? a[0] : null); return Task.Run(() => (object)paths.Select(p => ReadText(p as string)).ToList()); }
                case "writeText": { var p = Str(a, 0); var t = Str(a, 1) ?? ""; return Task.Run(() => { Write(p, Latin1.GetBytes(t)); return (object)true; }); }
                case "writeBase64": { var p = Str(a, 0); var b = Str(a, 1) ?? ""; return Task.Run(() => { Write(p, Convert.FromBase64String(b)); return (object)true; }); }
                case "reveal": Process.Start("explorer.exe", "/select,\"" + Str(a, 0) + "\""); return Done(null);
                case "openPath": Process.Start(new ProcessStartInfo(Str(a, 0)) { UseShellExecute = true }); return Done("");
                case "getSettings": return Done(LoadSettings());
                case "setSettings": return Done(MergeSettings(a.Length > 0 ? a[0] as Dictionary<string, object> : null));
                case "setTheme": return Done(SetTheme(Str(a, 0)));
                case "watch": return Done(Watch(Str(a, 0)));
                default: throw new InvalidOperationException("unknown method " + method);
            }
        }

        static Task<object> Done(object v) { return Task.FromResult(v); }

        // ------------------------------------------------------------------ files
        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
        static extern int StrCmpLogicalW(string a, string b);

        static string NameOf(string path)
        {
            var n = Path.GetFileName(path.TrimEnd('\\', '/'));
            return string.IsNullOrEmpty(n) ? path : n;
        }

        static bool Hidden(string name) { return name.StartsWith(".") || SkipDirs.Contains(name); }

        static Dictionary<string, object> ScanTree(string root)
        {
            int count = 0;
            return Walk(root, 0, ref count);
        }

        static Dictionary<string, object> Walk(string dir, int depth, ref int count)
        {
            var kids = new List<object>();
            var node = new Dictionary<string, object> { { "name", NameOf(dir) }, { "path", dir }, { "dir", true }, { "children", kids } };
            if (depth > MaxDepth || count > MaxEntries) return node;
            string[] dirs, files;
            try { dirs = Directory.GetDirectories(dir); files = Directory.GetFiles(dir); }
            catch { return node; }
            Comparison<string> natural = (x, y) => StrCmpLogicalW(NameOf(x), NameOf(y));
            var ds = dirs.Where(d => !Hidden(NameOf(d))).ToList();
            var fs = files.Where(f => !NameOf(f).StartsWith(".")).ToList();
            ds.Sort(natural);
            fs.Sort(natural);
            count += ds.Count + fs.Count;
            foreach (var d in ds) kids.Add(Walk(d, depth + 1, ref count));
            foreach (var f in fs) kids.Add(new Dictionary<string, object> { { "name", NameOf(f) }, { "path", f }, { "dir", false } });
            return node;
        }

        // Empty-holder folders near the opened folder: directories named like "holder",
        // "empty" or "dry run" in it and up to three levels above it.
        static List<string> DryRunFiles(string root)
        {
            var found = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Action<string, int> collect = null;
            collect = (dir, depth) =>
            {
                if (!seen.Add(dir)) return;
                try
                {
                    found.AddRange(Directory.GetFiles(dir).Where(f => RunFile.IsMatch(f)));
                    if (depth < 3)
                        foreach (var d in Directory.GetDirectories(dir))
                            if (!SkipDirs.Contains(NameOf(d))) collect(d, depth + 1);
                }
                catch { }
            };
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var anc = root;
            for (int up = 0; up <= 3 && anc != null; up++)
            {
                try
                {
                    foreach (var d in Directory.GetDirectories(anc))
                    {
                        var n = NameOf(d);
                        if (DryDir.IsMatch(n) && !SkipDirs.Contains(n)) collect(d, 0);
                    }
                }
                catch { }
                if (DryDir.IsMatch(NameOf(anc))) collect(anc, 0);
                if (string.Equals(anc.TrimEnd('\\'), home.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) break;
                anc = Path.GetDirectoryName(anc);
            }
            return found.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        static string ReadText(string p)
        {
            try { return p == null ? null : File.ReadAllText(p, Latin1); } catch { return null; }
        }

        // Output only ever goes into a *_corr folder, to a path picked in a save dialog, or to
        // a specimen notes file (*_notes.json): raw measurement files can never be overwritten.
        void Write(string p, byte[] bytes)
        {
            var full = Path.GetFullPath(p);
            var parent = NameOf(Path.GetDirectoryName(full) ?? "");
            if (!savedPaths.Contains(full) && !parent.EndsWith("_corr", StringComparison.OrdinalIgnoreCase)
                && !Path.GetFileName(full).EndsWith("_notes.json", StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("refusing to write outside a *_corr folder: " + p);
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            File.WriteAllBytes(full, bytes);
        }

        // A lone Alt (held to read values on the plot) would otherwise put the window into
        // menu mode, so the next arrow key opened the system menu. Alt+Space still works.
        protected override void WndProc(ref Message m)
        {
            const int WM_SYSCOMMAND = 0x0112, SC_KEYMENU = 0xF100;
            if (m.Msg == WM_SYSCOMMAND && ((int)m.WParam & 0xFFF0) == SC_KEYMENU && m.LParam == IntPtr.Zero) return;
            base.WndProc(ref m);
        }

        string StartupPath()
        {
            foreach (var a in args)
                if (!a.StartsWith("-") && (File.Exists(a) || Directory.Exists(a))) return Path.GetFullPath(a);
            return null;
        }

        bool Watch(string root)
        {
            if (watcher != null) { watcher.Dispose(); watcher = null; }
            if (root == null || !Directory.Exists(root)) return false;
            if (watchTimer == null)
            {
                watchTimer = new Timer { Interval = 800 };
                watchTimer.Tick += (o, e) => { watchTimer.Stop(); Post(new Dictionary<string, object> { { "event", "fs-changed" } }); };
            }
            try
            {
                watcher = new FileSystemWatcher(root) { IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite };
                FileSystemEventHandler changed = (o, e) =>
                {
                    var ext = Path.GetExtension(e.Name ?? "");
                    if (ext.Length > 0 && !RunFile.IsMatch(e.Name)) return;
                    BeginInvoke(new Action(() => { watchTimer.Stop(); watchTimer.Start(); }));
                };
                watcher.Created += changed;
                watcher.Deleted += changed;
                watcher.Changed += changed;
                watcher.Renamed += (o, e) => changed(o, e);
                watcher.EnableRaisingEvents = true;
                return true;
            }
            catch { return false; }
        }

        // ------------------------------------------------------------------ settings / theme
        string SettingsFile { get { return Path.Combine(dataDir, "settings.json"); } }

        Dictionary<string, object> LoadSettings()
        {
            try { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsFile, Encoding.UTF8)) ?? new Dictionary<string, object>(); }
            catch { return new Dictionary<string, object>(); }
        }

        void SaveSettings(Dictionary<string, object> s)
        {
            Directory.CreateDirectory(dataDir);
            File.WriteAllText(SettingsFile, json.Serialize(s), new UTF8Encoding(false));
        }

        Dictionary<string, object> MergeSettings(Dictionary<string, object> patch)
        {
            var s = LoadSettings();
            if (patch != null) foreach (var kv in patch) s[kv.Key] = kv.Value;
            SaveSettings(s);
            return s;
        }

        bool SetTheme(string t)
        {
            theme = t == "dark" || t == "light" ? t : "system";
            var dark = IsDark();
            if (web.CoreWebView2 != null) web.CoreWebView2.Profile.PreferredColorScheme = SchemeFor(theme);
            BackColor = dark ? Color.FromArgb(17, 19, 23) : Color.White;
            web.DefaultBackgroundColor = BackColor;
            ApplyTitleBar();
            return dark;
        }

        // ------------------------------------------------------------------ dialogs
        object SaveDialog(Dictionary<string, object> o)
        {
            using (var d = new SaveFileDialog())
            {
                d.OverwritePrompt = true;
                if (o != null && o.ContainsKey("title")) d.Title = o["title"] as string;
                var def = o != null && o.ContainsKey("defaultPath") ? o["defaultPath"] as string : null;
                if (def != null)
                {
                    d.FileName = Path.GetFileName(def);
                    var dir = Path.GetDirectoryName(def);
                    d.InitialDirectory = dir != null && Directory.Exists(dir) ? dir : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                }
                var filters = Arr(o != null && o.ContainsKey("filters") ? o["filters"] : null)
                    .OfType<Dictionary<string, object>>()
                    .Select(f =>
                    {
                        var exts = Arr(f.ContainsKey("extensions") ? f["extensions"] : null).Select(x => "*." + x).ToArray();
                        return (f.ContainsKey("name") ? f["name"] : "Files") + " (" + string.Join(";", exts) + ")|" + string.Join(";", exts);
                    }).ToArray();
                if (filters.Length > 0) d.Filter = string.Join("|", filters);
                if (d.ShowDialog(this) != DialogResult.OK) return null;
                savedPaths.Add(Path.GetFullPath(d.FileName));
                return d.FileName;
            }
        }

        string PickFolder(string start)
        {
            var dlg = (IFileOpenDialog)new FileOpenDialogCom();
            try
            {
                uint opts;
                dlg.GetOptions(out opts);
                dlg.SetOptions(opts | 0x20 | 0x40);                  // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
                dlg.SetTitle("Open data folder");
                IShellItem folder;
                if (start != null && Directory.Exists(start)) start = Path.GetFullPath(start);
                if (start != null && Directory.Exists(start) &&
                    SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out folder) == 0)
                    dlg.SetFolder(folder);
                if (dlg.Show(Handle) != 0) return null;            // cancelled
                IShellItem item;
                dlg.GetResult(out item);
                IntPtr p;
                item.GetDisplayName(0x80058000, out p);              // SIGDN_FILESYSPATH
                var path = Marshal.PtrToStringUni(p);
                Marshal.FreeCoTaskMem(p);
                return path;
            }
            finally { Marshal.ReleaseComObject(dlg); }
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        static extern int SHCreateItemFromParsingName(string path, IntPtr bindCtx, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogCom { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr specs);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem item);
            void SetFolder(IShellItem item);
            void GetFolder(out IShellItem item);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem item);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr bindCtx, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint sigdn, out IntPtr name);
            void GetAttributes(uint mask, out uint attribs);
            void Compare(IShellItem other, uint hint, out int order);
        }

        // ------------------------------------------------------------------ dev: scripted runs
        // TXS_SCRIPT=steps.json runs [{js, wait, shot}] in the page (off-screen), writing
        // results to TXS_LOG and PNG screenshots, then closes.
        async Task RunScript()
        {
            var log = Env("TXS_LOG");
            try
            {
                var steps = Arr(json.DeserializeObject(File.ReadAllText(script, Encoding.UTF8)));
                foreach (var st in steps.OfType<Dictionary<string, object>>())
                {
                    if (st.ContainsKey("js"))
                    {
                        var r = await web.CoreWebView2.ExecuteScriptAsync(st["js"] as string);
                        if (log != null) File.AppendAllText(log, r + Environment.NewLine, new UTF8Encoding(false));
                    }
                    if (st.ContainsKey("dialog")) PressDialogLater(st["dialog"] as Dictionary<string, object>, log);
                    if (st.ContainsKey("wait")) await Task.Delay(Convert.ToInt32(st["wait"]));
                    if (st.ContainsKey("shot"))
                        using (var f = File.Create(st["shot"] as string))
                            await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, f);
                }
            }
            catch (Exception ex) { if (log != null) File.AppendAllText(log, "script error: " + ex.Message + Environment.NewLine); }
            Close();
        }

        // {"dialog": {"after": ms, "button": "ok"|"cancel"}}: press a button on this process's
        // next common dialog, so dialog code paths can be exercised without a person.
        void PressDialogLater(Dictionary<string, object> d, string log)
        {
            var t = new Timer { Interval = d != null && d.ContainsKey("after") ? Convert.ToInt32(d["after"]) : 1500 };
            var ok = d != null && "ok".Equals(d["button"]);
            t.Tick += (o, e) =>
            {
                t.Stop(); t.Dispose();
                uint pid = (uint)Process.GetCurrentProcess().Id;
                EnumWindows((h, l) =>
                {
                    uint wpid; GetWindowThreadProcessId(h, out wpid);
                    var cls = new StringBuilder(64); GetClassName(h, cls, 64);
                    if (wpid == pid && cls.ToString() == "#32770" && IsWindowVisible(h))
                    {
                        var title = new StringBuilder(256); GetWindowText(h, title, 256);
                        if (log != null) File.AppendAllText(log, "dialog: " + title + " -> " + (ok ? "OK" : "Cancel") + Environment.NewLine);
                        PostMessage(h, 0x0111, (IntPtr)(ok ? 1 : 2), IntPtr.Zero);     // WM_COMMAND IDOK / IDCANCEL
                    }
                    return true;
                }, IntPtr.Zero);
            };
            t.Start();
        }

        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    }
}

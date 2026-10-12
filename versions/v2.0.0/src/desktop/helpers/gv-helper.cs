using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

// gv-helper.exe — GinyScreen 系统助手（本机运行，无 GUI）
// 子命令:
//   audio list                       列出当前默认播放设备上的音频会话
//   audio mute-others <pid> <tsv>    静音除 <pid> 外所有会话，快照存 <tsv>
//   audio restore <tsv>              按快照恢复各会话静音状态
//   radmin describe                  输出 Radmin VPN 进程/窗口/UIA 树摘要（调试用）
//   radmin create <name> <pwd>       UIA 自动化: Radmin VPN 创建网络
//   radmin join   <name> <pwd>       UIA 自动化: Radmin VPN 加入网络
// 结果以 stdout 文本输出，退出码 0=成功 1=失败（"ERR: ..." 行带原因）。

public static class Program {
    [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions]
    [System.Security.SecurityCritical]
    public static int Main(string[] args) {
        try {
            if (args.Length < 1) { Usage(); return 1; }
            switch (args[0].ToLowerInvariant()) {
                case "audio": return Audio(args);
                case "radmin": return Radmin(args);
                case "win": return Win(args);
                default: Usage(); return 1;
            }
        } catch (Exception ex) {
            DumpError(ex);
            return 1;
        }
    }

    static void DebugLog(string msg) {
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "gv-helper-debug.txt"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n"); } catch { }
    }

    static void DumpError(Exception ex) {
        try {
            var ce = ex as COMException;
            DebugLog("FATAL type=" + ex.GetType().FullName + " hr=" + (ce != null ? "0x" + ce.HResult.ToString("X8") : "n/a") + " msg=" + SafeName(ex.Message));
        } catch { }
        try { Console.WriteLine("ERR: " + SafeName(ex.Message)); } catch { }
    }

    static void Usage() {
        Console.WriteLine("usage: gv-helper.exe <audio list|audio mute-others <pid> <tsv> [skipPid...]|audio restore <tsv>|win pid <hwnd>|radmin describe|radmin ip|radmin create <name> <pwd>|radmin join <name> <pwd>>");
    }

        // ════════════ audio 子命令（基于 NAudio.CoreAudioApi，稳定可靠） ════════════
    class SessionInfo {
        public uint Pid;
        public string Name;
        public bool Muted;
        public NAudio.CoreAudioApi.AudioSessionControl Ctl;
    }

    static System.Collections.Generic.List<SessionInfo> EnumerateSessions(out string deviceName) {
        var result = new System.Collections.Generic.List<SessionInfo>();
        deviceName = "";
        var enumerator = new NAudio.CoreAudioApi.MMDeviceEnumerator();
        try {
            NAudio.CoreAudioApi.MMDevice device = null;
            try {
                device = enumerator.GetDefaultAudioEndpoint(NAudio.CoreAudioApi.DataFlow.Render, NAudio.CoreAudioApi.Role.Multimedia);
            } catch (Exception ex) {
                throw new Exception("找不到默认播放设备（未接音箱/耳机？）: " + SafeName(ex.Message));
            }
            deviceName = device.FriendlyName;
            var sessions = device.AudioSessionManager.Sessions;
            int count = sessions.Count;
            for (int i = 0; i < count; i++) {
                try {
                    var s = sessions[i];
                    uint pid = 0;
                    try { pid = s.GetProcessID; } catch { pid = 0; }
                    string name = s.DisplayName;
                    if (string.IsNullOrWhiteSpace(name)) name = DescribePid(pid);
                    if (string.IsNullOrWhiteSpace(name)) {
                        try { name = s.GetSessionIdentifier; } catch { name = ""; }
                    }
                    bool muted = false;
                    try { muted = s.SimpleAudioVolume != null && s.SimpleAudioVolume.Mute; } catch { muted = false; }
                    result.Add(new SessionInfo { Pid = pid, Name = name, Muted = muted, Ctl = s });
                } catch (Exception sex) {
                    DebugLog("session i=" + i + " EX=" + sex.GetType().Name + " " + SafeName(sex.Message));
                }
            }
        } finally {
            enumerator.Dispose();
        }
        return result;
    }

    static string DescribePid(uint pid) {
        if (pid == 0) return "System Sounds";
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "pid:" + pid; }
    }

    static string SafeName(string n) {
        if (string.IsNullOrEmpty(n)) return "?";
        return n.Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
    }

    // audio list
    static int AudioList() {
        string dev;
        var sessions = EnumerateSessions(out dev);
        Console.WriteLine("device=" + dev + " sessions=" + sessions.Count);
        foreach (var s in sessions) {
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0}\t{1}\tmuted={2}", s.Pid, SafeName(s.Name), s.Muted ? 1 : 0));
        }
        return 0;
    }

    // audio mute-others <pid> <tsv> [skipPid...]  — 静音除目标窗口进程外的所有会话
    static int AudioMuteOthers(string[] args) {
        uint targetPid;
        if (!uint.TryParse(args[2], out targetPid)) { Console.WriteLine("ERR: pid 无效"); return 1; }
        string stateFile = args[3];
        var skip = new HashSet<uint>();
        skip.Add(targetPid);
        for (int ai = 4; ai < args.Length; ai++) {
            uint sp;
            if (uint.TryParse(args[ai], out sp)) skip.Add(sp);
        }
        string dev;
        var sessions = EnumerateSessions(out dev);
        var sb = new StringBuilder();
        int muted = 0;
        foreach (var s in sessions) {
            sb.Append(s.Pid).Append('\t').Append(SafeName(s.Name)).Append('\t').Append(s.Muted ? 1 : 0).Append('\n');
            DebugLog("mute check pid=" + s.Pid + " ctlNull=" + (s.Ctl == null));
            if (!skip.Contains(s.Pid) && !s.Muted && s.Ctl != null && s.Ctl.SimpleAudioVolume != null) {
                try {
                    DebugLog("mute set pid=" + s.Pid);
                    s.Ctl.SimpleAudioVolume.Mute = true;
                    DebugLog("mute ok pid=" + s.Pid);
                    muted++;
                } catch (Exception ex) {
                    DebugLog("mute EX pid=" + s.Pid + " " + ex.GetType().Name + " " + SafeName(ex.Message));
                    Console.WriteLine("[audio] 静音失败 pid=" + s.Pid + ": " + ex.Message);
                }
            }
        }
        File.WriteAllText(stateFile, sb.ToString(), Encoding.UTF8);
        Console.WriteLine("muted=" + muted + " total=" + sessions.Count + " snapshot=" + stateFile);
        return 0;
    }

    // audio restore <tsv>
    static int AudioRestore(string[] args) {
        string stateFile = args[2];
        if (!File.Exists(stateFile)) { Console.WriteLine("ERR: 快照不存在 " + stateFile); return 1; }
        var wanted = new List<Tuple<uint, bool>>();
        foreach (var line in File.ReadAllLines(stateFile)) {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var parts = line.Split('\t');
            if (parts.Length < 3) continue;
            uint pid;
            if (uint.TryParse(parts[0], out pid) && (parts[2].Trim() == "1" || parts[2].Trim() == "0")) {
                wanted.Add(Tuple.Create(pid, parts[2].Trim() == "1"));
            }
        }
        string dev;
        var sessions = EnumerateSessions(out dev);
        int restored = 0;
        foreach (var w in wanted) {
            foreach (var s in sessions) {
                if (s.Pid == w.Item1 && s.Ctl != null && s.Ctl.SimpleAudioVolume != null && s.Muted != w.Item2) {
                    try { s.Ctl.SimpleAudioVolume.Mute = w.Item2; restored++; } catch { }
                }
            }
        }
        Console.WriteLine("restored=" + restored);
        return 0;
    }

    // win pid <hwnd> — 由窗口句柄反查进程 PID（共享窗口声音方案A用）
    static int Win(string[] args) {
        if (args.Length >= 3 && args[1].Equals("pid", StringComparison.OrdinalIgnoreCase)) {
            long hwnd;
            if (!long.TryParse(args[2], out hwnd) || hwnd <= 0) { Console.WriteLine("ERR: hwnd 无效"); return 1; }
            uint pid;
            if (GetWindowThreadProcessId((IntPtr)hwnd, out pid) == 0) { Console.WriteLine("ERR: 无效窗口句柄"); return 1; }
            Console.WriteLine("pid=" + pid);
            return 0;
        }
        Console.WriteLine("ERR: 未知 win 子命令");
        return 1;
    }

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions]
    static int Audio(string[] args) {
        if (args.Length >= 2 && args[1].Equals("list", StringComparison.OrdinalIgnoreCase)) return AudioList();
        if (args.Length >= 4 && args[1].Equals("mute-others", StringComparison.OrdinalIgnoreCase)) return AudioMuteOthers(args);
        if (args.Length >= 3 && args[1].Equals("restore", StringComparison.OrdinalIgnoreCase)) return AudioRestore(args);
        Console.WriteLine("ERR: 未知 audio 子命令");
        return 1;
    }
    // ════════════ radmin 子命令 ════════════
    static int Radmin(string[] args) {
        if (args.Length >= 2 && args[1].Equals("describe", StringComparison.OrdinalIgnoreCase)) {
            return RadminDescribe();
        }
        if (args.Length >= 2 && args[1].Equals("ip", StringComparison.OrdinalIgnoreCase)) {
            return RadminIp();
        }
        if (args.Length >= 4 && (args[1].Equals("create", StringComparison.OrdinalIgnoreCase) || args[1].Equals("join", StringComparison.OrdinalIgnoreCase))) {
            return RadminNetwork(args[1], args[2], args[3]);
        }
        Console.WriteLine("ERR: 未知 radmin 子命令");
        return 1;
    }

    static int RadminIp() {
        try {
            var found = new List<string>();
            foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()) {
                if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                string desc = ni.Description ?? "";
                string name = ni.Name ?? "";
                if (desc.IndexOf("Radmin", StringComparison.OrdinalIgnoreCase) < 0 && name.IndexOf("Radmin", StringComparison.OrdinalIgnoreCase) < 0) continue;
                var props = ni.GetIPProperties();
                foreach (var ua in props.UnicastAddresses) {
                    if (ua.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) {
                        found.Add(ua.Address.ToString());
                    }
                }
            }
            if (found.Count > 0) { Console.WriteLine("ip=" + string.Join(",", found.ToArray())); return 0; }
        } catch (Exception ex) {
            Console.WriteLine("ERR: " + SafeName(ex.Message));
            return 1;
        }
        Console.WriteLine("ip=none");
        return 1;
    }
    static Process FindRadmin() {
        foreach (var p in Process.GetProcesses()) {
            try {
                if (p.ProcessName.IndexOf("Radmin", StringComparison.OrdinalIgnoreCase) >= 0) return p;
            } catch { }
        }
        return null;
    }

    static int RadminDescribe() {
        var p = FindRadmin();
        if (p == null) { Console.WriteLine("status=not-running"); return 0; }
        Console.WriteLine("status=running pid=" + p.Id + " name=" + p.ProcessName);
        try {
            if (p.MainWindowHandle != IntPtr.Zero) {
                var root = AutomationElement.FromHandle(p.MainWindowHandle);
                Console.WriteLine("window=" + root.Current.Name + " class=" + root.Current.ClassName);
                var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                var names = new List<string>();
                foreach (AutomationElement el in all) {
                    var n = el.Current.Name;
                    var t = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
                    if (!string.IsNullOrEmpty(n)) names.Add(t + ":" + n);
                }
                int shown = 0;
                foreach (var n in names) { if (shown++ >= 80) break; Console.WriteLine("  " + n); }
                Console.WriteLine("total-nodes=" + names.Count);
            } else {
                Console.WriteLine("window=no-main-window");
            }
        } catch (Exception ex) { Console.WriteLine("uia-error=" + ex.Message); }
        return 0;
    }

    static int RadminNetwork(string mode, string name, string pwd) {
        var p = FindRadmin();
        if (p == null) { Console.WriteLine("ERR: Radmin VPN 未运行"); return 1; }
        IntPtr hwnd = p.MainWindowHandle;
        if (hwnd == IntPtr.Zero) { p.Refresh(); hwnd = p.MainWindowHandle; }
        if (hwnd == IntPtr.Zero) { Console.WriteLine("ERR: Radmin VPN 没有主窗口（可能未登录）"); return 1; }
        Console.WriteLine("[radmin] window=" + WindowText(hwnd));

        var root = AutomationElement.FromHandle(hwnd);
        var menu = FindByNames(root, new[] { "网络", "Network", "Networks" }, new[] { ControlType.MenuItem, ControlType.Button, ControlType.Menu });
        if (menu == null) { Console.WriteLine("ERR: 找不到「网络」菜单"); return 1; }
        Invoke(menu, "网络菜单");
        Thread.Sleep(600);

        var targetWords = mode == "create"
            ? new[] { "创建网络", "Create Network", "New Network", "创建新网络" }
            : new[] { "加入网络", "Join Network", "加入现有网络", "Join" };
        var item = FindByNames(root, targetWords, new[] { ControlType.MenuItem, ControlType.ListItem, ControlType.Button });
        if (item == null) item = FindByNames(AutomationElement.RootElement, targetWords, new[] { ControlType.MenuItem, ControlType.ListItem, ControlType.Button });
        if (item == null) { Console.WriteLine("ERR: 找不到「" + (mode == "create" ? "创建网络" : "加入网络") + "」菜单项"); return 1; }
        Invoke(item, mode + "菜单项");
        Thread.Sleep(900);

        var dlg = FindDialogWindow(new[] { "创建", "Create", "加入", "Join", "网络", "Network" });
        if (dlg == null) dlg = root;
        var edits = FindAllByType(dlg, ControlType.Edit);
        Console.WriteLine("[radmin] edits=" + edits.Length);
        if (edits.Length < 1) { Console.WriteLine("ERR: 找不到输入框"); return 1; }
        SetEdit(edits[0], name, "网络名称");
        if (edits.Length >= 2) SetEdit(edits[1], pwd, "密码");
        if (edits.Length >= 3) SetEdit(edits[2], pwd, "确认密码");
        Thread.Sleep(200);

        var ok = FindByNames(dlg, new[] { "确定", "OK", "创建", "Create", "加入", "Join", "是", "Yes" }, new[] { ControlType.Button });
        if (ok == null) { SendEnter(hwnd); Console.WriteLine("[radmin] 未找到确定按钮，已按回车"); }
        else Invoke(ok, "确定按钮");
        Thread.Sleep(1200);

        CloseMessageBoxes();
        Console.WriteLine("ok " + mode + " name=" + name);
        return 0;
    }

    static string WindowText(IntPtr hwnd) {
        var sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    static void Invoke(AutomationElement el, string label) {
        try { ((InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); Console.WriteLine("[radmin] invoked " + label); return; } catch { }
        try { ((ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand(); Console.WriteLine("[radmin] expanded " + label); return; } catch { }
        try { ((SelectionItemPattern)el.GetCurrentPattern(SelectionItemPattern.Pattern)).Select(); Console.WriteLine("[radmin] selected " + label); return; } catch { }
        Console.WriteLine("[radmin] warn: 无法激活 " + label);
    }

    static AutomationElement FindByNames(AutomationElement root, string[] keywords, ControlType[] types) {
        try {
            var cond = new OrCondition(Array.ConvertAll(types, t => new PropertyCondition(AutomationElement.ControlTypeProperty, t)));
            var all = root.FindAll(TreeScope.Descendants, cond);
            foreach (AutomationElement el in all) {
                var n = el.Current.Name ?? "";
                foreach (var kw in keywords) {
                    if (n.IndexOf(kw, StringComparison.OrdinalIgnoreCase) >= 0) return el;
                }
            }
        } catch { }
        return null;
    }

    static AutomationElement[] FindAllByType(AutomationElement root, ControlType type) {
        var cond = new PropertyCondition(AutomationElement.ControlTypeProperty, type);
        var all = root.FindAll(TreeScope.Descendants, cond);
        var res = new AutomationElement[all.Count];
        for (int i = 0; i < all.Count; i++) res[i] = all[i];
        return res;
    }

    static void SetEdit(AutomationElement el, string text, string label) {
        try {
            ((ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern)).SetValue(text);
            Console.WriteLine("[radmin] filled " + label);
            return;
        } catch { }
        try {
            var isAscii = true;
            foreach (char c in text) if (c > 127) { isAscii = false; break; }
            if (isAscii) {
                el.SetFocus();
                SetForegroundWindow((IntPtr)el.Current.NativeWindowHandle);
                Thread.Sleep(120);
                foreach (char c in text) {
                    short sc = VkKeyScan(c);
                    if (sc == -1) continue;
                    byte vk = (byte)(sc & 0xFF);
                    bool shift = (sc & 0x0100) != 0;
                    if (shift) keybd_event(0x10, 0, 0, UIntPtr.Zero);
                    keybd_event(vk, 0, 0, UIntPtr.Zero);
                    keybd_event(vk, 0, 2, UIntPtr.Zero);
                    if (shift) keybd_event(0x10, 0, 2, UIntPtr.Zero);
                }
            } else {
                el.SetFocus();
                System.Windows.Clipboard.SetText(text);
                SendKey(0x11); SendKey(0x56);
            }
            Console.WriteLine("[radmin] typed " + label);
        } catch (Exception ex) {
            Console.WriteLine("[radmin] warn: 填写" + label + "失败 " + ex.Message);
        }
    }

    static void SendKey(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }

    static AutomationElement FindDialogWindow(string[] keywords) {
        try {
            var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            foreach (AutomationElement w in all) {
                var n = w.Current.Name ?? "";
                if (n.Length == 0) continue;
                if (w.Current.ControlType == ControlType.Window || w.Current.ControlType == ControlType.Pane) {
                    foreach (var kw in keywords) {
                        if (n.IndexOf(kw, StringComparison.OrdinalIgnoreCase) >= 0) return w;
                    }
                }
            }
        } catch { }
        return null;
    }

    static void CloseMessageBoxes() {
        try {
            var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            foreach (AutomationElement w in all) {
                var cls = w.Current.ClassName ?? "";
                if (cls.IndexOf("#32770", StringComparison.Ordinal) >= 0) {
                    var btn = FindByNames(w, new[] { "确定", "OK", "是", "Yes", "关闭", "Close" }, new[] { ControlType.Button });
                    if (btn != null) Invoke(btn, "消息框按钮");
                }
            }
        } catch { }
    }

    static void SendEnter(IntPtr hwnd) {
        SetForegroundWindow(hwnd);
        Thread.Sleep(150);
        keybd_event(0x0D, 0, 0, UIntPtr.Zero);
        keybd_event(0x0D, 0, 2, UIntPtr.Zero);
    }

    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    static extern short VkKeyScan(char ch);
}

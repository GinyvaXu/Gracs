using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

// gv-helper.exe — Gracs 系统助手（本机运行，无 GUI）
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

    // audio capture [--pid N]：把声音以裸 PCM 写到 stdout。
    //   --pid N：只采集该进程及其子进程的声音（Windows 进程回环，Win10 2004+/11；用于避开语音软件回音）
    //   无 --pid：采集整个系统混音（WASAPI 回环）
    // 输出：首行 "#PCM <rate> <channels> 16"，随后为 s16le 交错采样（立体声）。结束：父进程终止本进程。
    static int AudioCapture(uint pid) {
        if (pid > 0) return AudioCaptureProcess(pid);
        try {
            var enumerator = new NAudio.CoreAudioApi.MMDeviceEnumerator();
            var device = enumerator.GetDefaultAudioEndpoint(NAudio.CoreAudioApi.DataFlow.Render, NAudio.CoreAudioApi.Role.Multimedia);
            using (var cap = new NAudio.Wave.WasapiLoopbackCapture(device)) {
                var outStream = Console.OpenStandardOutput();
                var fmt = cap.WaveFormat;
                var header = Encoding.ASCII.GetBytes(string.Format(CultureInfo.InvariantCulture,
                    "#PCM {0} {1} 16\n", fmt.SampleRate, Math.Min(2, fmt.Channels)));
                outStream.Write(header, 0, header.Length);
                outStream.Flush();

                cap.DataAvailable += delegate(object s, NAudio.Wave.WaveInEventArgs e) {
                    try {
                        var wf = cap.WaveFormat;
                        int bps = wf.BitsPerSample / 8;
                        int frame = bps * wf.Channels;
                        if (frame <= 0 || e.BytesRecorded < frame) return;
                        int frames = e.BytesRecorded / frame;
                        var outBuf = new byte[frames * 4];
                        int o = 0;
                        for (int i = 0; i < frames; i++) {
                            double l, r;
                            if (wf.Channels == 1) { l = ReadAudioSample(e.Buffer, i * frame, wf); r = l; }
                            else {
                                l = ReadAudioSample(e.Buffer, i * frame, wf);
                                r = ReadAudioSample(e.Buffer, i * frame + bps, wf);
                            }
                            short sl = ToPcm16(l), sr = ToPcm16(r);
                            outBuf[o++] = (byte)(sl & 0xFF);
                            outBuf[o++] = (byte)((sl >> 8) & 0xFF);
                            outBuf[o++] = (byte)(sr & 0xFF);
                            outBuf[o++] = (byte)((sr >> 8) & 0xFF);
                        }
                        outStream.Write(outBuf, 0, o);
                        outStream.Flush();
                    } catch {
                        Environment.Exit(0); // 父进程退出（管道关闭）→ 结束
                    }
                };
                cap.StartRecording();
                // 持续运行，直到父进程终止本进程（写管道失败会触发退出）
                try { Thread.Sleep(Timeout.Infinite); } catch { }
                try { cap.StopRecording(); } catch { }
            }
            return 0;
        } catch (Exception ex) {
            Console.WriteLine("ERR: " + SafeName(ex.Message));
            return 1;
        }
    }

    static double ReadAudioSample(byte[] buf, int offset, NAudio.Wave.WaveFormat wf) {
        if (wf.Encoding == NAudio.Wave.WaveFormatEncoding.IeeeFloat) return BitConverter.ToSingle(buf, offset);
        if (wf.BitsPerSample == 16) return BitConverter.ToInt16(buf, offset) / 32768.0;
        if (wf.BitsPerSample == 24) return (buf[offset] | (buf[offset + 1] << 8) | ((sbyte)buf[offset + 2] << 16)) / 8388608.0;
        if (wf.BitsPerSample == 32) return BitConverter.ToInt32(buf, offset) / 2147483648.0;
        return 0;
    }

    static short ToPcm16(double v) {
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        return (short)Math.Round(v * 32767.0);
    }

    // ════════════ 进程回环采集（只采指定应用的声音）════════════
    // Windows 10 2004+/11 的 AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK：
    // 只采集目标进程及其子进程的音频（OBS「应用音频采集」同款），其它应用（语音软件）不受影响。
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    const int AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = unchecked((int)0x80000000);
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;
    const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
    const int PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
    const int VT_BLOB = 65;

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_ACTIVATION_PARAMS {
        public int ActivationType;
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    // 敏捷对象标记：Windows 从 MTA 工作线程回调完成处理器，未实现该接口会得到 E_ILLEGAL_METHOD_CALL
    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject {
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IRawAudioClient {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IRawAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, IntPtr devicePosition, IntPtr qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true)]
    static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation operation);

    [ComVisible(true)]
    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Hr = -1;
        public object Client;
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) {
            object obj = null;
            int hr = -1;
            try { op.GetActivateResult(out hr, out obj); } catch (Exception ex) { DebugLog("GetActivateResult 异常: " + SafeName(ex.Message)); }
            Hr = hr;
            Client = obj;
            Done.Set();
        }
    }

    static IRawAudioClient ActivateProcessLoopbackClient(uint pid) {
        var activation = new AUDIOCLIENT_ACTIVATION_PARAMS();
        activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        activation.ProcessLoopbackParams.TargetProcessId = pid;
        activation.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

        int structSize = Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
        IntPtr blobPtr = Marshal.AllocCoTaskMem(structSize);
        int pvSize = IntPtr.Size == 8 ? 24 : 16;
        IntPtr pvPtr = Marshal.AllocCoTaskMem(pvSize);
        var handler = new ActivationHandler();
        try {
            Marshal.StructureToPtr(activation, blobPtr, false);
            for (int i = 0; i < pvSize; i++) Marshal.WriteByte(pvPtr, i, 0);
            Marshal.WriteInt16(pvPtr, 0, VT_BLOB);
            Marshal.WriteInt32(pvPtr, 8, structSize);
            Marshal.WriteIntPtr(pvPtr, IntPtr.Size == 8 ? 16 : 12, blobPtr);

            Guid iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            IActivateAudioInterfaceAsyncOperation op;
            // 进程回环使用虚拟设备路径 VAD\Process_Loopback（普通回环才用物理设备 ID）
            int hr = ActivateAudioInterfaceAsync(@"VAD\Process_Loopback", ref iid, pvPtr, handler, out op);
            if (hr != 0) { DebugLog("ActivateAudioInterfaceAsync hr=0x" + hr.ToString("X8")); return null; }
            if (!handler.Done.WaitOne(5000)) { DebugLog("进程回环激活超时"); return null; }
            if (handler.Hr != 0) { DebugLog("进程回环激活结果 hr=0x" + handler.Hr.ToString("X8")); return null; }
            return handler.Client as IRawAudioClient;
        } catch (Exception ex) {
            DebugLog("进程回环激活异常: " + SafeName(ex.Message));
            return null;
        } finally {
            Marshal.FreeCoTaskMem(blobPtr);
            Marshal.FreeCoTaskMem(pvPtr);
        }
    }

    static int AudioCaptureProcess(uint pid) {
        try {
            var client = ActivateProcessLoopbackClient(pid);
            if (client == null) {
                Console.WriteLine("ERR: 无法单独采集该应用（需要 Windows 10 2004+/11，或应用不再发声）");
                return 1;
            }
            // 进程回环不绑定物理设备，GetMixFormat 不可用（E_NOTIMPL）：
            // 自备 16bit 48kHz 立体声 PCM + AUTOCONVERTPCM 让音频引擎自动转换（与官方样例一致）
            const int rate = 48000;
            const int channels = 2;
            const int bits = 16;
            int blockAlign = channels * bits / 8;
            IntPtr fmtPtr = Marshal.AllocCoTaskMem(18);
            try {
                for (int i = 0; i < 18; i++) Marshal.WriteByte(fmtPtr, i, 0);
                Marshal.WriteInt16(fmtPtr, 0, (short)1);                // WAVE_FORMAT_PCM
                Marshal.WriteInt16(fmtPtr, 2, (short)channels);
                Marshal.WriteInt32(fmtPtr, 4, rate);
                Marshal.WriteInt32(fmtPtr, 8, rate * blockAlign);
                Marshal.WriteInt16(fmtPtr, 12, (short)blockAlign);
                Marshal.WriteInt16(fmtPtr, 14, (short)bits);

                int flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                int hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, fmtPtr, IntPtr.Zero);
                if (hr != 0) { Console.WriteLine("ERR: 初始化进程回环失败 (0x" + hr.ToString("X8") + ")"); return 1; }
                Guid capIid = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
                object capObj;
                hr = client.GetService(ref capIid, out capObj);
                if (hr != 0 || capObj == null) { Console.WriteLine("ERR: 获取采集接口失败 (0x" + hr.ToString("X8") + ")"); return 1; }
                var capture = (IRawAudioCaptureClient)capObj;
                hr = client.Start();
                if (hr != 0) { Console.WriteLine("ERR: 启动采集失败 (0x" + hr.ToString("X8") + ")"); return 1; }

                var outStream = Console.OpenStandardOutput();
                var header = Encoding.ASCII.GetBytes(string.Format(CultureInfo.InvariantCulture,
                    "#PCM {0} {1} 16\n", rate, channels));
                outStream.Write(header, 0, header.Length);
                outStream.Flush();

                int bps = bits / 8;
                int frameSize = blockAlign;
                while (true) {
                    uint packet;
                    hr = capture.GetNextPacketSize(out packet);
                    if (hr != 0) break;
                    while (packet > 0) {
                        IntPtr data;
                        uint frames;
                        uint flags2;
                        hr = capture.GetBuffer(out data, out frames, out flags2, IntPtr.Zero, IntPtr.Zero);
                        if (hr != 0) break;
                        if (frames > 0 && data != IntPtr.Zero && (flags2 & AUDCLNT_BUFFERFLAGS_SILENT) == 0) {
                            int bytes = (int)frames * frameSize;
                            var src = new byte[bytes];
                            Marshal.Copy(data, src, 0, bytes);
                            WritePcm16(outStream, src, (int)frames, frameSize, bps, channels, false);
                        }
                        capture.ReleaseBuffer(frames);
                        hr = capture.GetNextPacketSize(out packet);
                    }
                    Thread.Sleep(10);
                }
                return 0;
            } finally {
                Marshal.FreeCoTaskMem(fmtPtr);
            }
        } catch (Exception ex) {
            Console.WriteLine("ERR: " + SafeName(ex.Message));
            return 1;
        }
    }

    static void WritePcm16(System.IO.Stream outStream, byte[] src, int frames, int frameSize, int bps, int channels, bool isFloat) {
        var outBuf = new byte[frames * 4];
        int o = 0;
        for (int i = 0; i < frames; i++) {
            int off = i * frameSize;
            double l, r;
            if (channels == 1) { l = ReadSampleRaw(src, off, bps, isFloat); r = l; }
            else {
                l = ReadSampleRaw(src, off, bps, isFloat);
                r = ReadSampleRaw(src, off + bps, bps, isFloat);
            }
            short sl = ToPcm16(l), sr = ToPcm16(r);
            outBuf[o++] = (byte)(sl & 0xFF);
            outBuf[o++] = (byte)((sl >> 8) & 0xFF);
            outBuf[o++] = (byte)(sr & 0xFF);
            outBuf[o++] = (byte)((sr >> 8) & 0xFF);
        }
        outStream.Write(outBuf, 0, o);
        outStream.Flush();
    }

    static double ReadSampleRaw(byte[] buf, int offset, int bps, bool isFloat) {
        if (isFloat) return bps == 4 ? BitConverter.ToSingle(buf, offset) : 0;
        if (bps == 2) return BitConverter.ToInt16(buf, offset) / 32768.0;
        if (bps == 3) return (buf[offset] | (buf[offset + 1] << 8) | ((sbyte)buf[offset + 2] << 16)) / 8388608.0;
        if (bps == 4) return BitConverter.ToInt32(buf, offset) / 2147483648.0;
        return 0;
    }

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

    // audio list（UTF-8 输出：应用名可能是中文，避免控制台代码页乱码）
    static int AudioList() {
        string dev;
        var sessions = EnumerateSessions(out dev);
        var sb = new StringBuilder();
        sb.Append("device=").Append(dev).Append(" sessions=").Append(sessions.Count).Append("\n");
        foreach (var s in sessions) {
            sb.Append(s.Pid).Append('\t').Append(SafeName(s.Name)).Append("\tmuted=").Append(s.Muted ? "1" : "0").Append('\n');
        }
        var bytes = Encoding.UTF8.GetBytes(sb.ToString());
        var stdout = Console.OpenStandardOutput();
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
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
        if (args.Length >= 2 && args[1].Equals("capture", StringComparison.OrdinalIgnoreCase)) {
            uint pid = 0;
            for (int i = 2; i < args.Length - 1; i++) {
                if (args[i].Equals("--pid", StringComparison.OrdinalIgnoreCase)) {
                    uint.TryParse(args[i + 1], out pid);
                }
            }
            return AudioCapture(pid);
        }
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

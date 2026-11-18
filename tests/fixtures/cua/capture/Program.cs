using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length is 2 or 3 && args[0] == "fixture")
        {
            var title = args[1];
            Application.SetHighDpiMode(args.Length == 3 && args[2] == "unaware" ? HighDpiMode.DpiUnaware : HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            using var form = new Form { Text = title, Width = 550, Height = 360, BackColor = Color.Teal, StartPosition = FormStartPosition.CenterScreen, TopMost = true };
            var button = new Button { Text = "Pi CUA button", AccessibleName = "Pi CUA button", Left = 28, Top = 28, Width = 160 };
            var field = new TextBox { Text = "Pi CUA value", AccessibleName = "Pi CUA field", Left = 28, Top = 70, Width = 240 };
            // Popup scenarios: a button whose click opens a modal dialog (blocking UIA Invoke),
            // a native drop-down list (ComboLBox) and a ToolStrip context menu owned by the form.
            var modalButton = new Button { Text = "Pi CUA modal button", AccessibleName = "Pi CUA modal button", Left = 220, Top = 28, Width = 200 };
            var combo = new ComboBox { AccessibleName = "Pi CUA combo", DropDownStyle = ComboBoxStyle.DropDownList, Left = 28, Top = 112, Width = 200 };
            combo.Items.AddRange(["Alpha", "Beta", "Gamma"]);
            combo.SelectedIndex = 0;
            var menu = new ContextMenuStrip();
            menu.Items.Add("Pi CUA menu item", null, (_, _) => Console.WriteLine(JsonSerializer.Serialize(new { kind = "menu" })));
            form.ContextMenuStrip = menu;
            form.Controls.AddRange([button, field, modalButton, combo]);
            button.Click += (_, _) => Console.WriteLine(JsonSerializer.Serialize(new { kind = "click" }));
            field.TextChanged += (_, _) => Console.WriteLine(JsonSerializer.Serialize(new { kind = "value", value = field.Text }));
            combo.SelectedIndexChanged += (_, _) => Console.WriteLine(JsonSerializer.Serialize(new { kind = "combo", value = combo.Text }));
            menu.Opened += (_, _) => Console.WriteLine(JsonSerializer.Serialize(new { kind = "menu-opened", hwnd = menu.Handle.ToInt64(), itemHeight = menu.Items[0].Height }));
            form.Shown += (_, _) =>
            {
                field.Focus();
                Console.WriteLine(JsonSerializer.Serialize(new { kind = "ready", hwnd = form.Handle.ToInt64(), dpi = form.DeviceDpi, button = button.Handle.ToInt64(), field = field.Handle.ToInt64(), comboItemHeight = combo.ItemHeight }));
            };
            Form? popup = null;
            void OpenPopup()
            {
                using var dialog = new Form { Text = "Pi CUA modal fixture", StartPosition = FormStartPosition.CenterParent, Width = 320, Height = 180, TopMost = true };
                popup = dialog;
                dialog.Shown += (_, _) => Console.WriteLine(JsonSerializer.Serialize(new { kind = "popup", hwnd = dialog.Handle.ToInt64() }));
                dialog.ShowDialog(form);
                popup = null;
                Console.WriteLine(JsonSerializer.Serialize(new { kind = "popup-closed" }));
            }
            modalButton.Click += (_, _) => OpenPopup();
            Listen(form, line =>
            {
                if (line == "focus") { form.Activate(); field.Focus(); }
                if (line == "move") { form.Left += 30; form.Top += 20; }
                if (line == "reposition") form.Location = new Point(30, 30);
                if (line is "focus" or "move" or "reposition") Console.WriteLine(JsonSerializer.Serialize(new { kind = line }));
                if (line == "popup") OpenPopup();
                if (line == "close-popup") popup?.Close();
            });
            Application.Run(form);
            return;
        }

        if (args is ["overlay", var left, var top, var width, var height])
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            using var overlay = new OverlayForm
            {
                BackColor = Color.DarkOrange,
                Bounds = new Rectangle(int.Parse(left), int.Parse(top), int.Parse(width), int.Parse(height)),
                FormBorderStyle = FormBorderStyle.None,
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                TopMost = true,
            };
            overlay.Shown += (_, _) => Console.WriteLine(JsonSerializer.Serialize(new { kind = "ready", hwnd = overlay.Handle.ToInt64() }));
            Listen(overlay, _ => { });
            Application.Run(overlay);
            return;
        }

        if (args is not ["measure", var hwnd, var count, var backend] || !long.TryParse(hwnd, out var handle) ||
            !int.TryParse(count, out var samples) || samples < 1 || samples > 20 || backend is not ("PrintWindow" or "WGC"))
        {
            throw new ArgumentException("Expected: fixture <title> or measure <fixture HWND> <samples> <PrintWindow|WGC>");
        }
        var result = Measure((nint)handle, samples, backend).GetAwaiter().GetResult();
        Console.WriteLine(JsonSerializer.Serialize(result));
    }

    private sealed class OverlayForm : Form
    {
        protected override bool ShowWithoutActivation => true;
        protected override CreateParams CreateParams
        {
            get { var parameters = base.CreateParams; parameters.ExStyle |= 0x08000000; return parameters; }
        }
    }

    private static void Listen(Form form, Action<string> command)
    {
        form.HandleCreated += (_, _) => _ = Task.Run(() =>
        {
            while (Console.ReadLine() is { } line)
            {
                if (line == "close") break;
                form.BeginInvoke(() => command(line));
            }
            form.BeginInvoke(form.Close);
        });
    }

    private static async Task<object> Measure(nint hwnd, int samples, string backend)
    {
        if (!GetWindowRect(hwnd, out var rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top)
            throw new InvalidOperationException("Fixture window is unavailable.");
        var rows = new List<Sample>();
        Func<Task<bool>> capture = backend == "PrintWindow" ? () => Task.FromResult(Print(hwnd, rect)) : () => Capture(hwnd);
        for (var index = 0; index < samples; index++) rows.Add(await SampleOnce(backend, capture));
        return rows;
    }

    private sealed record Sample(string Backend, bool NonBlank, double Milliseconds, double CpuMilliseconds, long WorkingSetBytes, string? Error);

    private static async Task<Sample> SampleOnce(string backend, Func<Task<bool>> capture)
    {
        using var process = Process.GetCurrentProcess();
        var cpu = process.TotalProcessorTime;
        var sw = Stopwatch.StartNew();
        try
        {
            var nonBlank = await capture();
            return new(backend, nonBlank, sw.Elapsed.TotalMilliseconds, (process.TotalProcessorTime - cpu).TotalMilliseconds, process.WorkingSet64, null);
        }
        catch (Exception error)
        {
            return new(backend, false, sw.Elapsed.TotalMilliseconds, (process.TotalProcessorTime - cpu).TotalMilliseconds, process.WorkingSet64,
                $"0x{error.HResult:x8} {error.TargetSite?.Name}: {error.Message.Trim()}");
        }
    }

    private static bool Print(nint hwnd, Rect rect)
    {
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        using var bitmap = new Bitmap(width, height);
        using var graphics = Graphics.FromImage(bitmap);
        var dc = graphics.GetHdc();
        try
        {
            if (!PrintWindow(hwnd, dc, 2)) throw new InvalidOperationException("PrintWindow returned false.");
        }
        finally { graphics.ReleaseHdc(dc); }
        var first = bitmap.GetPixel(width / 5, height / 5).ToArgb();
        for (var y = 1; y <= 8; y++)
            for (var x = 1; x <= 8; x++)
                if (bitmap.GetPixel(x * width / 9, y * height / 9).ToArgb() != first) return true;
        return false;
    }

    private static async Task<bool> Capture(nint hwnd)
    {
        if (!GraphicsCaptureSession.IsSupported()) throw new PlatformNotSupportedException("Windows.Graphics.Capture is unsupported.");
        using var device = CreateDevice();
        var item = CreateItem(hwnd);
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        var arrived = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Receive(Direct3D11CaptureFramePool sender, object _)
        {
            var frame = sender.TryGetNextFrame();
            if (frame is not null && !arrived.TrySetResult(frame)) frame.Dispose();
        }
        pool.FrameArrived += Receive;
        try
        {
            session.StartCapture();
            using var frame = await arrived.Task.WaitAsync(TimeSpan.FromSeconds(2));
            using var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Ignore);
            var width = bitmap.PixelWidth;
            var height = bitmap.PixelHeight;
            var buffer = new Windows.Storage.Streams.Buffer((uint)(width * height * 4));
            bitmap.CopyToBuffer(buffer);
            using var reader = DataReader.FromBuffer(buffer);
            var pixels = new byte[buffer.Length];
            reader.ReadBytes(pixels);
            uint ColorAt(int x, int y) => BitConverter.ToUInt32(pixels, (y * width + x) * 4) & 0xffffff;
            var first = ColorAt(width / 5, height / 5);
            for (var y = 1; y <= 8; y++)
                for (var x = 1; x <= 8; x++)
                    if (ColorAt(x * width / 9, y * height / 9) != first) return true;
            return false;
        }
        finally
        {
            pool.FrameArrived -= Receive;
            arrived.TrySetCanceled();
        }
    }

    // COM ABI for IGraphicsCaptureItemInterop::CreateForWindow (IUnknown slot 3).
    private static GraphicsCaptureItem CreateItem(nint hwnd)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        var interop = new Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356");
        var itemIid = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
        Marshal.ThrowExceptionForHR(WindowsCreateString(className, (uint)className.Length, out var hstring));
        try
        {
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(hstring, ref interop, out var factory));
            try
            {
                var function = Marshal.ReadIntPtr(Marshal.ReadIntPtr(factory), 3 * IntPtr.Size);
                var create = Marshal.GetDelegateForFunctionPointer<CreateForWindow>(function);
                Marshal.ThrowExceptionForHR(create(factory, hwnd, ref itemIid, out var item));
                try { return MarshalInterface<GraphicsCaptureItem>.FromAbi(item); }
                finally { Marshal.Release(item); }
            }
            finally { Marshal.Release(factory); }
        }
        finally { WindowsDeleteString(hstring); }
    }

    private static IDirect3DDevice CreateDevice()
    {
        // D3D_DRIVER_TYPE_HARDWARE, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION
        Marshal.ThrowExceptionForHR(D3D11CreateDevice(0, 1, 0, 0x20, 0, 0, 7, out var native, out _, out var context));
        try
        {
            var dxgiIid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native, in dxgiIid, out var dxgi));
            try
            {
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var device));
                try { return MarshalInterface<IDirect3DDevice>.FromAbi(device); }
                finally { Marshal.Release(device); }
            }
            finally { Marshal.Release(dxgi); }
        }
        finally { Marshal.Release(context); Marshal.Release(native); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CreateForWindow(nint self, nint window, ref Guid iid, out nint result);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(nint window, nint dc, uint flags);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] private static extern int WindowsCreateString(string text, uint length, out nint hstring);
    [DllImport("combase.dll")] private static extern int WindowsDeleteString(nint hstring);
    [DllImport("combase.dll")] private static extern int RoGetActivationFactory(nint hstring, ref Guid iid, out nint result);
    [DllImport("d3d11.dll")] private static extern int D3D11CreateDevice(nint adapter, int driver, nint software, uint flags, nint levels, uint count, uint sdk, out nint device, out uint featureLevel, out nint context);
    [DllImport("d3d11.dll")] private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgi, out nint device);
}

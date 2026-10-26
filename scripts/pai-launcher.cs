using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// A GUI executable lets Explorer resolve "pai" without a console or script host.
//
// Fast path: when the main Pi Desktop instance is already running it listens on
// a per-user named pipe; the launcher sends one JSON request and exits without
// starting another Electron process. Everything else (no listener, timeout,
// rejected request) falls back to spawning the application with --pai.
internal static class PaiLauncher
{
    private const string ApplicationName = "Pi Desktop.exe";
    private const int ConnectTimeoutMs = 1500;
    private const int ResponseTimeoutMs = 5000;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string directory = ParseDirectory(args);
            if (TryOpenHostedWindow(directory, null)) return 0;
            StartApplication(directory);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "pai - Pi Desktop", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    /// Pipe name shared with the Electron main process (paiPipe.ts): the SHA-256
    /// hash of the user name keeps instances of different local users apart.
    private static string PipeName()
    {
        using (SHA256 hash = SHA256.Create())
        {
            byte[] digest = hash.ComputeHash(Encoding.UTF8.GetBytes(Environment.UserName ?? ""));
            StringBuilder name = new StringBuilder("pi-desktop-pai-", 16 + 32);
            for (int index = 0; index < 8; index++) name.Append(digest[index].ToString("x2"));
            return name.ToString();
        }
    }

    /// <summary>
    /// One JSON line out, one JSON line back, guarded by a thread join so even a
    /// hung or foreign listener cannot stall pai longer than the timeouts.
    /// </summary>
    private static bool TryOpenHostedWindow(string directory, string sessionPath)
    {
        bool delivered = false;
        Thread worker = new Thread(delegate()
        {
            try { delivered = ExchangeWithHost(directory, sessionPath); }
            catch { delivered = false; }
        });
        worker.IsBackground = true;
        worker.Start();
        return worker.Join(ConnectTimeoutMs + ResponseTimeoutMs) && delivered;
    }

    private static bool ExchangeWithHost(string directory, string sessionPath)
    {
        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName(), PipeDirection.InOut))
        {
            pipe.Connect(ConnectTimeoutMs);
            StringBuilder request = new StringBuilder();
            request.Append("{\"cwd\":").Append(JsonString(directory));
            if (sessionPath != null) request.Append(",\"sessionPath\":").Append(JsonString(sessionPath));
            request.Append("}\n");
            byte[] payload = Encoding.UTF8.GetBytes(request.ToString());
            pipe.Write(payload, 0, payload.Length);
            pipe.Flush();
            string response = ReadLine(pipe);
            return response != null && response.Contains("\"ok\":true");
        }
    }

    private static string ReadLine(PipeStream pipe)
    {
        byte[] chunk = new byte[1];
        StringBuilder line = new StringBuilder();
        while (line.Length <= 4096)
        {
            int read = pipe.Read(chunk, 0, 1);
            if (read <= 0) break;
            char character = (char)chunk[0];
            if (character == '\n') return line.ToString();
            if (character != '\r') line.Append(character);
        }
        return null;
    }

    private static void StartApplication(string directory)
    {
        string binDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string application = Path.GetFullPath(Path.Combine(binDirectory, "..", ApplicationName));
        if (!File.Exists(application))
            throw new FileNotFoundException("Pi Desktop executable was not found. Reinstall Pi Desktop to repair the pai command.", application);

        ProcessStartInfo start = new ProcessStartInfo(application);
        start.Arguments = "--pai --cwd " + QuoteArgument(directory);
        start.WorkingDirectory = directory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        using (Process process = Process.Start(start)) { }
    }

    internal static string ParseDirectory(string[] args)
    {
        string directory;
        if (args.Length == 0) directory = Directory.GetCurrentDirectory();
        else if (args.Length == 1 && args[0].StartsWith("--cwd=", StringComparison.Ordinal))
            directory = args[0].Substring("--cwd=".Length);
        else if (args.Length == 1 && !IsDirectoryOption(args[0])) directory = args[0];
        else if (args.Length == 2 && IsDirectoryOption(args[0])) directory = args[1];
        else throw new ArgumentException("Usage: pai [folder] or pai --cwd <folder>");

        if (String.IsNullOrWhiteSpace(directory)) throw new ArgumentException("pai requires a filesystem directory.");
        directory = Path.GetFullPath(directory);
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("The folder does not exist: " + directory);
        return directory;
    }

    private static bool IsDirectoryOption(string argument)
    {
        return String.Equals(argument, "-Cwd", StringComparison.OrdinalIgnoreCase)
            || String.Equals(argument, "--cwd", StringComparison.Ordinal);
    }

    private static string JsonString(string value)
    {
        StringBuilder quoted = new StringBuilder("\"");
        foreach (char character in value)
        {
            if (character == '"' || character == '\\') quoted.Append('\\').Append(character);
            else if (character < ' ') quoted.Append("\\u").Append(((int)character).ToString("x4"));
            else quoted.Append(character);
        }
        return quoted.Append('"').ToString();
    }

    // Follow the Windows CRT argv rules, including a quoted drive root's final \.
    internal static string QuoteArgument(string value)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') quoted.Append('\\', slashes * 2 + 1);
            else quoted.Append('\\', slashes);
            quoted.Append(character);
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }
}

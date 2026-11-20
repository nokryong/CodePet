using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using Icon = System.Drawing.Icon;

internal sealed class NativePet : Window
{
    private readonly System.Windows.Controls.Image image = new System.Windows.Controls.Image();
    private readonly DispatcherTimer timer = new DispatcherTimer();
    private readonly Dictionary<int, BitmapSource[]> frames = new Dictionary<int, BitmapSource[]>();
    private readonly Forms.NotifyIcon tray;
    private readonly Forms.ToolStripMenuItem visibility;
    private BitmapSource sheet;
    private string spritePath;
    private int spriteRows;
    private int row;
    private int column;
    private bool workMode;
    private bool hidden;
    private bool positioned;
    private bool ready;
    private static StreamWriter output;

    public NativePet(Icon icon)
    {
        Title = "CodePet Native Pet";
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ShowInTaskbar = false;
        ShowActivated = false;
        Topmost = true;
        Content = image;

        var menu = new Forms.ContextMenuStrip();
        AddCommand(menu, "에이전트 채팅방…", "chat");
        AddCommand(menu, "설정…", "settings");
        AddCommand(menu, "남은 한도 보기…", "usage");
        AddCommand(menu, "Live 음성 대화…", "live");
        visibility = new Forms.ToolStripMenuItem("펫 숨기기");
        visibility.Click += delegate { hidden = !hidden; UpdateVisibility(); };
        menu.Items.Add(visibility);
        menu.Items.Add("종료", null, delegate { Application.Current.Shutdown(); });
        tray = new Forms.NotifyIcon { Icon = icon, Text = "CodePet (네이티브 실험 모드)", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { Send("chat"); };

        MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
            if (e.ClickCount == 2) { Send("chat"); return; }
            DragMove();
        };
        MouseRightButtonUp += delegate { var p = Forms.Cursor.Position; menu.Show(p); };
        Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) {
            if (Application.Current.Dispatcher.HasShutdownStarted) return;
            e.Cancel = true;
            hidden = true;
            UpdateVisibility();
        };
        timer.Tick += delegate { PaintNextFrame(); };
    }

    private static void Send(string command)
    {
        output.WriteLine(command);
    }

    private static void AddCommand(Forms.ContextMenuStrip menu, string label, string command)
    {
        menu.Items.Add(label, null, delegate { Send(command); });
    }

    public void DisposeTray()
    {
        timer.Stop();
        tray.ContextMenuStrip.Dispose();
        tray.Dispose();
    }

    private void UpdateVisibility()
    {
        visibility.Enabled = !workMode;
        visibility.Text = hidden ? "펫 보이기" : "펫 숨기기";
        if (workMode || hidden || sheet == null) {
            timer.Stop();
            Hide();
            return;
        }
        if (!IsVisible) {
            PaintNextFrame();
            Show();
        }
        timer.Start();
    }

    public void ReadCommand(string line)
    {
        var parts = line.Split('\t');
        if (parts.Length == 2 && parts[0] == "state") {
            SetState(parts[1]);
            return;
        }
        if (parts.Length != 5 || parts[0] != "settings") return;
        workMode = parts[1] == "1";
        Width = int.Parse(parts[2]);
        Height = Math.Round(Width * 208 / 192);
        if (!positioned) {
            var area = SystemParameters.WorkArea;
            Left = area.Left + area.Width * 0.55;
            Top = area.Bottom - Height - 32;
            positioned = true;
        }
        if (spritePath != parts[4] || spriteRows != int.Parse(parts[3])) {
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.UriSource = new Uri(parts[4]);
            bitmap.EndInit();
            bitmap.Freeze();
            sheet = bitmap;
            spritePath = parts[4];
            spriteRows = int.Parse(parts[3]);
            frames.Clear();
            column = 0;
            PaintNextFrame();
        }
        UpdateVisibility();
        if (!ready) {
            ready = true;
            Send(IsVisible ? "ready:visible" : "ready:hidden");
        }
    }

    private void SetState(string state)
    {
        int next = state == "running" ? 7 : state == "review" ? 8 : state == "waiting" ? 6 : state == "failed" ? 5 : 0;
        timer.Interval = TimeSpan.FromMilliseconds(next == 5 || next == 7 ? 250 : 333);
        if (row == next) return;
        row = next;
        column = 0;
        if (IsVisible) PaintNextFrame();
    }

    private BitmapSource[] GetFrames(int spriteRow)
    {
        BitmapSource[] cached;
        if (frames.TryGetValue(spriteRow, out cached)) return cached;
        int width = sheet.PixelWidth / 8;
        int height = sheet.PixelHeight / spriteRows;
        int count = spriteRow == 0 || (spriteRows == 11 && spriteRow >= 6) ? 6 : 8;
        var cells = new List<BitmapSource>(count);
        for (int frame = 0; frame < count; frame++) {
            var crop = new CroppedBitmap(sheet, new Int32Rect(frame * width, spriteRow * height, width, height));
            var pixels = new byte[width * height * 4];
            new FormatConvertedBitmap(crop, PixelFormats.Bgra32, null, 0).CopyPixels(pixels, width * 4, 0);
            for (int i = 3; i < pixels.Length; i += 4) {
                if (pixels[i] == 0) continue;
                cells.Add(crop);
                break;
            }
        }
        return frames[spriteRow] = cells.ToArray();
    }

    private void PaintNextFrame()
    {
        var cells = GetFrames(row);
        if (cells.Length == 0) cells = GetFrames(0);
        if (cells.Length > 0) image.Source = cells[column++ % cells.Length];
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 2) return 1;
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        bool first;
        using (var mutex = new Mutex(true, "Local\\CodePet.Native." + args[1], out first)) {
            if (!first) return 2;
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            using (var icon = new Icon(args[0])) {
                var pet = new NativePet(icon);
                pet.SetState("idle");
                app.Exit += delegate { pet.DisposeTray(); };
                var input = new Thread(delegate() {
                    using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) {
                        string line;
                        while ((line = reader.ReadLine()) != null) {
                            string command = line;
                            app.Dispatcher.BeginInvoke(new Action(delegate { pet.ReadCommand(command); }));
                        }
                    }
                    app.Dispatcher.BeginInvoke(new Action(delegate { app.Shutdown(); }));
                }) { IsBackground = true };
                input.Start();
                return app.Run();
            }
        }
    }
}

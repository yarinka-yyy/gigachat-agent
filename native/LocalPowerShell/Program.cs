using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 1;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint CreateNew = 1;
    private const uint FileAttributeNormal = 0x80;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInfoClass = 9;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x102;
    private const int ErrorInsufficientBuffer = 122;
    private const uint SecurityInfoOwner = 0x00000001;
    private const uint SecurityInfoGroup = 0x00000002;
    private const uint SecurityInfoDacl = 0x00000004;
    private const uint SecurityInfoLabel = 0x00000010;
    private const nuint ProcThreadAttributeHandleList = 0x00020002;
    private const nuint ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const string ProfilePrefix = "GigaChatLocalTools-";
    private const int MaxScriptChars = 16 * 1024;
    private const int MaxInputBytes = 1024 * 1024;
    private const int MaxRequestChars = 2 * 1024 * 1024;
    private const int MaxBrokerJournalBytes = 16 * 1024;
    private const int MaxRelativePathChars = 2048;
    private const int MaxOutputBytes = 4 * 1024 * 1024;
    private const int MaxTimeoutMs = 120_000;
    private const int MaxRunLockWaitMs = 10_000;
    private const int MaxRecoveryLockWaitMs = 3_000;
    private const uint ProcessQueryLimitedInformation = 0x00001000;
    private const uint ProcessSynchronize = 0x00100000;
    private const uint ToolhelpSnapshotProcess = 0x00000002;
    private const uint MaxAppDataExitWaitMs = 120_000;
    private const int MaxAppDataDeleteWaitMs = 30_000;
    private const int AppDataDeleteRetryDelayMs = 200;
    private const uint MessageBoxErrorFlags = 0x00000010 | 0x00010000;
    private const string ProductDataDirectoryName = "GigaChat Agents";
    private const string ProductExecutableName = "GigaChat Agents.exe";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false };

    private static int Main(string[] args)
    {
        string stage = "initialize UTF-8 console";
        try
        {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false);
            stage = "dispatch helper operation";
            if (args.Length == 2 && args[0] == "--recover")
            {
                stage = "recover runtime state";
                string directory = PrepareRecoveryDirectory(args[1]);
                using FileStream runtimeLock = AcquireRuntimeLock(directory, MaxRecoveryLockWaitMs);
                Recover(directory);
                Console.WriteLine("{\"recovered\":true}");
                return 0;
            }
            if (args.Length == 2 && args[0] == "--run")
            {
                stage = "run bounded process";
                Run(args[1]);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--write")
            {
                stage = "write project file";
                WriteProjectFile(args[1]);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--delete-app-data")
            {
                stage = "delete application data";
                if (!uint.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out uint parentProcessId)
                    || parentProcessId == 0)
                    throw new InvalidDataException("Некорректный идентификатор приложения.");
                return DeleteAppDataAfterParentExit(parentProcessId);
            }
            WriteError("Некорректный режим запуска.", 87);
            return 2;
        }
        catch (Exception error)
        {
            Exception cause = error.InnerException ?? error;
            string safeStage = error is InvalidOperationException && error.Message.Contains(':')
                ? error.Message[..error.Message.IndexOf(':')]
                : stage;
            WriteError(cause is Win32Exception ? "Сбой ограниченного запуска Windows." : "Локальный runtime не выполнил действие.",
                cause is Win32Exception win32 ? win32.NativeErrorCode : cause.HResult, safeStage);
            return 1;
        }
    }

    private static void WriteProjectFile(string recoveryDirectoryInput)
    {
        string stage = "validate request";
        try
        {
            if (string.IsNullOrWhiteSpace(recoveryDirectoryInput) || !Path.IsPathFullyQualified(recoveryDirectoryInput))
                throw new InvalidDataException("Некорректная папка runtime.");
            BrokerWriteRequest request = JsonSerializer.Deserialize<BrokerWriteRequest>(
                ReadBounded(Console.In, MaxRequestChars), JsonOptions)
                ?? throw new InvalidDataException("Пустой запрос.");
            string[] parts = ValidateRelativeFilePath(request.RelativePath);
            if (request.ContentsBase64 is null)
                throw new InvalidDataException("Содержимое файла не задано.");
            if (request.ContentsBase64.Length > checked(((MaxInputBytes + 2) / 3) * 4))
                throw new InvalidDataException("Содержимое превышает лимит 1 МиБ.");
            byte[] payload = Convert.FromBase64String(request.ContentsBase64);
            if (payload.Length > MaxInputBytes || Convert.ToBase64String(payload) != request.ContentsBase64)
                throw new InvalidDataException("Содержимое превышает лимит 1 МиБ.");
            string content = new UTF8Encoding(false, true).GetString(payload);
            if (content.Contains('\0')) throw new InvalidDataException("Бинарное содержимое запрещено.");

            stage = "prepare runtime lock";
            string recoveryDirectory = PrepareRecoveryDirectory(recoveryDirectoryInput);
            using FileStream runtimeLock = AcquireRuntimeLock(recoveryDirectory, MaxRunLockWaitMs);
            Recover(recoveryDirectory);

            stage = "validate project path";
            string root = ValidateDirectory(request.WorkingFolder, "Рабочая папка");
            if (root.Equals(recoveryDirectory, StringComparison.OrdinalIgnoreCase)
                || IsWithin(root, recoveryDirectory) || IsWithin(recoveryDirectory, root))
                throw new InvalidDataException("Рабочая папка пересекается с папкой runtime.");
            string target = Path.GetFullPath(Path.Combine(root, Path.Combine(parts)));
            if (!IsWithin(target, root)) throw new InvalidDataException("Путь выходит за границы проекта.");

            stage = "prepare target directory";
            string relativeParent = Path.GetDirectoryName(Path.Combine(parts)) ?? string.Empty;
            string current = root;
            foreach (string component in relativeParent.Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
            {
                EnsureNoReparseComponents(current);
                current = Path.Combine(current, component);
                if (File.Exists(current)) throw new InvalidDataException("Компонент пути не является папкой.");
                if (!Directory.Exists(current)) Directory.CreateDirectory(current);
                EnsureNoReparseComponents(current);
            }
            string parent = Path.GetDirectoryName(target) ?? throw new InvalidDataException("Некорректная папка файла.");
            EnsureNoReparseComponents(root);
            EnsureNoReparseComponents(parent);
            EnsureNoReparseComponents(target);
            if (Directory.Exists(target)) throw new InvalidDataException("Путь указывает на папку.");

            bool targetExists = File.Exists(target);
            string id = Guid.NewGuid().ToString("N");
            string temporaryLeaf = $".gigachat-write-{id}.tmp";
            string backupLeaf = $".gigachat-write-{id}.bak";
            string temporary = Path.Combine(parent, temporaryLeaf);
            string backup = Path.Combine(parent, backupLeaf);
            string journal = Path.Combine(recoveryDirectory, $"write-{id}.json");
            var journalData = new BrokerWriteJournal(id, root, request.RelativePath, targetExists, temporaryLeaf, backupLeaf);
            bool preserveJournal = false;

            stage = "write temporary file";
            WriteBrokerJournal(journal, journalData);
            try
            {
                EnsureNoReparseComponents(root);
                EnsureNoReparseComponents(parent);
                if (File.Exists(temporary) || File.Exists(backup))
                    throw new IOException("Не удалось выделить временное имя файла.");
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    4096, FileOptions.WriteThrough))
                {
                    stream.Write(payload, 0, payload.Length);
                    stream.Flush(true);
                }
                Array.Clear(payload);
                SecuritySnapshot temporarySecurity = ReadSecuritySnapshot(temporary);
                bool currentTargetExists = File.Exists(target);
                if (targetExists != currentTargetExists || Directory.Exists(target))
                    throw new IOException("Целевой файл изменился до записи.");

                if (targetExists)
                {
                    stage = "preflight target security descriptor";
                    SecuritySnapshot originalSecurity = ReadSecuritySnapshot(target);
                    RequireSupportedSecurity(originalSecurity, temporarySecurity);

                    stage = "revalidate target before replace";
                    EnsureNoReparseComponents(root);
                    EnsureNoReparseComponents(parent);
                    EnsureNoReparseComponents(target);
                    EnsureNoReparseComponents(temporary);
                    if (!File.Exists(target) || !File.Exists(temporary)
                        || !SecurityEquals(originalSecurity, ReadSecuritySnapshot(target))
                        || !SecurityEquals(temporarySecurity, ReadSecuritySnapshot(temporary)))
                        throw new IOException("Путь или дескриптор изменился до замены.");

                    stage = "replace existing file";
                    File.Replace(temporary, target, backup);
                    SecuritySnapshot replacedSecurity = ReadSecuritySnapshot(target);
                    if (!SecurityEquals(originalSecurity, replacedSecurity))
                    {
                        stage = "restore original file after descriptor mismatch";
                        File.Move(backup, target, overwrite: true);
                        if (!SecurityEquals(originalSecurity, ReadSecuritySnapshot(target)))
                        {
                            preserveJournal = true;
                            throw new IOException("Дескриптор исходного файла не удалось восстановить.");
                        }
                        throw new InvalidDataException("EXISTING_FILE_REPLACE_UNAVAILABLE");
                    }
                    File.Delete(backup);
                }
                else
                {
                    stage = "revalidate new-file target";
                    EnsureNoReparseComponents(root);
                    EnsureNoReparseComponents(parent);
                    EnsureNoReparseComponents(temporary);
                    if (File.Exists(target) || Directory.Exists(target))
                        throw new IOException("Целевой путь появился до записи.");
                    stage = "move new file into place";
                    File.Move(temporary, target);
                    if (!SecurityEquals(temporarySecurity, ReadSecuritySnapshot(target)))
                    {
                        File.Delete(target);
                        throw new InvalidDataException("NEW_FILE_DESCRIPTOR_UNAVAILABLE");
                    }
                }

                stage = "clean write journal";
                File.Delete(journal);
                Console.WriteLine(JsonSerializer.Serialize(new BrokerWriteResult(payload.Length, targetExists)));
            }
            catch
            {
                if (File.Exists(temporary)) File.Delete(temporary);
                if (File.Exists(backup)) preserveJournal = true;
                if (!preserveJournal && File.Exists(journal)) File.Delete(journal);
                throw;
            }
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"{stage}: {error.Message}", error);
        }
    }

    private static int DeleteAppDataAfterParentExit(uint parentProcessId)
    {
        string stage = "read cleanup request";
        bool readySent = false;
        IntPtr parentHandle = IntPtr.Zero;
        try
        {
            DeleteAppDataRequest request = JsonSerializer.Deserialize<DeleteAppDataRequest>(
                ReadBounded(Console.In, 16 * 1024), JsonOptions)
                ?? throw new InvalidDataException("Пустой запрос очистки.");
            if (string.IsNullOrWhiteSpace(request.UserDataPath) || !Path.IsPathFullyQualified(request.UserDataPath))
                throw new InvalidDataException("Некорректная папка данных приложения.");

            stage = "validate known-folder path";
            string appData = ResolveRoamingAppDataPath();
            string userData = ValidateUserDataTarget(appData, request.UserDataPath, requireExistingNormalDirectory: true);

            stage = "open confirmed application process";
            parentHandle = Native.OpenProcess(ProcessSynchronize | ProcessQueryLimitedInformation, false, parentProcessId);
            if (parentHandle == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess");
            if (Native.GetProcessId(parentHandle) != parentProcessId)
                throw new InvalidDataException("Идентификатор приложения изменился.");

            stage = "validate confirmed application process";
            string parentImage = GetProcessImagePath(parentHandle);
            string expectedParentImage = GetInstalledApplicationPath();
            if (!PathsMatch(parentImage, expectedParentImage)
                || GetParentProcessId((uint)Environment.ProcessId) != parentProcessId)
                throw new InvalidDataException("Помощник вызван не подтверждённым приложением.");

            stage = "send ready handshake";
            Console.WriteLine(JsonSerializer.Serialize(new DeleteAppDataReady(true, parentProcessId, true)));
            Console.Out.Flush();
            readySent = true;

            stage = "wait for application exit";
            uint waitResult = Native.WaitForSingleObject(parentHandle, MaxAppDataExitWaitMs);
            if (waitResult == WaitTimeout) throw new TimeoutException("Приложение не завершилось за отведённое время.");
            if (waitResult != WaitObject0) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject(application)");

            stage = "delete validated application data";
            DeleteUserDataWithRetry(appData, userData);
            return 0;
        }
        catch (Exception error)
        {
            if (!readySent) throw new InvalidOperationException($"delete-app-data: {stage}", error);
            ShowAppDataDeleteFailure(error);
            return 1;
        }
        finally
        {
            if (parentHandle != IntPtr.Zero) Native.CloseHandle(parentHandle);
        }
    }

    private static string ResolveRoamingAppDataPath()
    {
        string knownFolder = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (string.IsNullOrWhiteSpace(knownFolder) || !Path.IsPathFullyQualified(knownFolder))
            throw new InvalidDataException("Roaming AppData недоступен.");
        string fullPath = NormalizeDirectoryPath(knownFolder);
        EnsureNoReparseComponents(fullPath);
        FileAttributes attributes = File.GetAttributes(fullPath);
        if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Roaming AppData содержит перенаправление.");
        return fullPath;
    }

    private static string ValidateUserDataTarget(string appData, string requestedPath, bool requireExistingNormalDirectory)
    {
        string expected = NormalizeDirectoryPath(Path.Combine(appData, ProductDataDirectoryName));
        string requested = NormalizeDirectoryPath(requestedPath);
        if (!PathsMatch(requested, expected)
            || !PathsMatch(Path.GetDirectoryName(expected) ?? string.Empty, appData)
            || !string.Equals(Path.GetRelativePath(appData, expected), ProductDataDirectoryName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Путь не является прямой папкой данных приложения.");

        FileAttributes? attributes = GetAttributesOrNull(expected);
        if (attributes.HasValue && (attributes.Value & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Папка данных приложения содержит перенаправление.");
        if (requireExistingNormalDirectory
            && (!attributes.HasValue
                || (attributes.Value & FileAttributes.Directory) == 0
                || (attributes.Value & FileAttributes.ReparsePoint) != 0))
            throw new InvalidDataException("Папка данных приложения отсутствует или перенаправлена.");
        if (attributes.HasValue && (attributes.Value & FileAttributes.Directory) == 0
            && (attributes.Value & FileAttributes.ReparsePoint) == 0)
            throw new InvalidDataException("Путь данных приложения больше не является папкой.");
        return expected;
    }

    private static void DeleteUserDataWithRetry(string expectedAppData, string expectedUserData)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(MaxAppDataDeleteWaitMs);
        while (true)
        {
            string currentAppData = ResolveRoamingAppDataPath();
            if (!PathsMatch(currentAppData, expectedAppData))
                throw new InvalidDataException("Roaming AppData изменился после закрытия приложения.");
            string target = ValidateUserDataTarget(currentAppData, expectedUserData, requireExistingNormalDirectory: false);
            if (!GetAttributesOrNull(target).HasValue) return;

            try
            {
                DeleteAppDataEntry(target, target);
                if (GetAttributesOrNull(target).HasValue)
                    throw new IOException("Папка данных приложения осталась после удаления.");
                return;
            }
            catch (IOException)
            {
                if (DateTime.UtcNow >= deadline)
                    throw new TimeoutException("Не удалось полностью удалить папку данных приложения.");
                Thread.Sleep(AppDataDeleteRetryDelayMs);
            }
            catch (UnauthorizedAccessException)
            {
                if (DateTime.UtcNow >= deadline)
                    throw new TimeoutException("Не удалось полностью удалить папку данных приложения.");
                Thread.Sleep(AppDataDeleteRetryDelayMs);
            }

            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException("Не удалось полностью удалить папку данных приложения.");
        }
    }

    private static void DeleteAppDataEntry(string path, string userDataRoot)
    {
        string fullPath = Path.GetFullPath(path);
        if (!IsSameOrWithin(fullPath, userDataRoot))
            throw new InvalidDataException("Элемент данных вышел за выбранную папку приложения.");
        FileAttributes? maybeAttributes = GetAttributesOrNull(fullPath);
        if (!maybeAttributes.HasValue) return;
        FileAttributes attributes = maybeAttributes.Value;

        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            if ((attributes & FileAttributes.Directory) != 0) Directory.Delete(fullPath, recursive: false);
            else File.Delete(fullPath);
            return;
        }

        if ((attributes & FileAttributes.Directory) == 0)
        {
            File.Delete(fullPath);
            return;
        }

        var pending = new Stack<(string Path, bool RemoveAfterChildren)>();
        pending.Push((fullPath, false));
        while (pending.Count > 0)
        {
            (string current, bool removeAfterChildren) = pending.Pop();
            current = Path.GetFullPath(current);
            if (!IsSameOrWithin(current, userDataRoot))
                throw new InvalidDataException("Элемент данных вышел за выбранную папку приложения.");
            FileAttributes? currentMaybeAttributes = GetAttributesOrNull(current);
            if (!currentMaybeAttributes.HasValue) continue;
            FileAttributes currentAttributes = currentMaybeAttributes.Value;
            bool isDirectory = (currentAttributes & FileAttributes.Directory) != 0;
            bool isReparse = (currentAttributes & FileAttributes.ReparsePoint) != 0;

            if (isReparse)
            {
                if (isDirectory) Directory.Delete(current, recursive: false);
                else File.Delete(current);
            }
            else if (isDirectory && !removeAfterChildren)
            {
                pending.Push((current, true));
                foreach (string child in Directory.EnumerateFileSystemEntries(current))
                    pending.Push((child, false));
            }
            else if (isDirectory)
            {
                Directory.Delete(current, recursive: false);
            }
            else
            {
                File.Delete(current);
            }
        }
    }

    private static FileAttributes? GetAttributesOrNull(string path)
    {
        try { return File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    private static string GetProcessImagePath(IntPtr processHandle)
    {
        var buffer = new StringBuilder(32_768);
        uint length = (uint)buffer.Capacity;
        if (!Native.QueryFullProcessImageNameW(processHandle, 0, buffer, ref length))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryFullProcessImageName");
        return NormalizeDirectoryPath(buffer.ToString());
    }

    private static string GetInstalledApplicationPath()
    {
        string helperPath = Environment.ProcessPath
            ?? throw new InvalidDataException("Путь native helper недоступен.");
        string? resourcesDirectory = Path.GetDirectoryName(Path.GetFullPath(helperPath));
        if (string.IsNullOrWhiteSpace(resourcesDirectory)
            || !string.Equals(Path.GetFileName(resourcesDirectory), "resources", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Путь native helper не принадлежит установленной версии приложения.");
        string? installDirectory = Directory.GetParent(resourcesDirectory)?.FullName;
        if (string.IsNullOrWhiteSpace(installDirectory))
            throw new InvalidDataException("Папка установленного приложения недоступна.");
        string executable = Path.GetFullPath(Path.Combine(installDirectory, ProductExecutableName));
        if (!File.Exists(executable)) throw new InvalidDataException("Исполняемый файл приложения не найден рядом с helper.");
        return NormalizeDirectoryPath(executable);
    }

    private static uint GetParentProcessId(uint processId)
    {
        IntPtr snapshot = Native.CreateToolhelp32Snapshot(ToolhelpSnapshotProcess, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateToolhelp32Snapshot");
        try
        {
            var entry = new ProcessEntry32 { Size = (uint)Marshal.SizeOf<ProcessEntry32>() };
            if (!Native.Process32FirstW(snapshot, ref entry))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Process32First");
            do
            {
                if (entry.ProcessId == processId) return entry.ParentProcessId;
            } while (Native.Process32NextW(snapshot, ref entry));
            throw new InvalidDataException("Процесс helper отсутствует в системном снимке процессов.");
        }
        finally { Native.CloseHandle(snapshot); }
    }

    private static string NormalizeDirectoryPath(string path)
    {
        string fullPath = Path.GetFullPath(path);
        string root = Path.GetPathRoot(fullPath) ?? throw new InvalidDataException("Путь без корня диска.");
        return fullPath.Length > root.Length
            ? fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            : fullPath;
    }

    private static bool PathsMatch(string left, string right) =>
        string.Equals(NormalizeDirectoryPath(left), NormalizeDirectoryPath(right), StringComparison.OrdinalIgnoreCase);

    private static bool IsSameOrWithin(string path, string parent)
    {
        string relative = Path.GetRelativePath(parent, path);
        return relative == "." || (relative != ".."
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !Path.IsPathFullyQualified(relative));
    }

    private static void ShowAppDataDeleteFailure(Exception error)
    {
        int code = error is Win32Exception win32 ? win32.NativeErrorCode : error.HResult;
        string text = $"Не удалось полностью удалить локальные данные приложения после его закрытия. Папка данных могла быть удалена частично. Проверьте папку GigaChat Agents в Roaming AppData после закрытия всех окон приложения. Код ошибки: {code}.";
        Native.MessageBoxW(IntPtr.Zero, text, "Удаление не завершено", MessageBoxErrorFlags);
    }

    private static void RequireSupportedSecurity(SecuritySnapshot target, SecuritySnapshot temporary)
    {
        if (!string.Equals(target.Owner, temporary.Owner, StringComparison.Ordinal)
            || !string.Equals(target.Group, temporary.Group, StringComparison.Ordinal)
            || !string.Equals(target.Dacl, temporary.Dacl, StringComparison.Ordinal)
            || !string.Equals(target.Label, temporary.Label, StringComparison.Ordinal))
            throw new InvalidDataException("EXISTING_FILE_SECURITY_UNSUPPORTED");
    }

    private static bool SecurityEquals(SecuritySnapshot left, SecuritySnapshot right) =>
        string.Equals(left.Owner, right.Owner, StringComparison.Ordinal)
        && string.Equals(left.Group, right.Group, StringComparison.Ordinal)
        && string.Equals(left.Dacl, right.Dacl, StringComparison.Ordinal)
        && string.Equals(left.Label, right.Label, StringComparison.Ordinal);

    private static SecuritySnapshot ReadSecuritySnapshot(string path)
    {
        uint result = Native.GetNamedSecurityInfoW(path, 1, SecurityInfoOwner | SecurityInfoGroup
            | SecurityInfoDacl | SecurityInfoLabel, out _, out _, out _, out _, out IntPtr descriptor);
        if (result != 0) throw new Win32Exception(unchecked((int)result), "GetNamedSecurityInfoW");
        try
        {
            return new SecuritySnapshot(
                ConvertSecurityPart(descriptor, SecurityInfoOwner),
                ConvertSecurityPart(descriptor, SecurityInfoGroup),
                ConvertSecurityPart(descriptor, SecurityInfoDacl),
                ConvertSecurityPart(descriptor, SecurityInfoLabel));
        }
        finally { if (descriptor != IntPtr.Zero) Native.LocalFree(descriptor); }
    }

    private static string? ConvertSecurityPart(IntPtr descriptor, uint information)
    {
        if (!Native.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, information,
                out IntPtr text, out _))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertSecurityDescriptorToStringSecurityDescriptorW");
        try { return Marshal.PtrToStringUni(text); }
        finally { if (text != IntPtr.Zero) Native.LocalFree(text); }
    }

    private static void WriteBrokerJournal(string path, BrokerWriteJournal journal)
    {
        EnsureNoReparseComponents(path);
        string temporary = path + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            4096, FileOptions.WriteThrough))
        {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(journal);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
        File.Move(temporary, path);
    }

    private static void RecoverBrokerWriteJournal(string path, string recoveryDirectory)
    {
        EnsureNoReparseComponents(path);
        var info = new FileInfo(path);
        if (info.Length > MaxBrokerJournalBytes) throw new InvalidDataException("Журнал записи превышает лимит.");
        BrokerWriteJournal journal = JsonSerializer.Deserialize<BrokerWriteJournal>(File.ReadAllText(path), JsonOptions)
            ?? throw new InvalidDataException("Повреждён журнал записи.");
        string fileId = Path.GetFileNameWithoutExtension(path)[6..];
        if (!Guid.TryParseExact(fileId, "N", out _) || journal.Id != fileId
            || journal.TemporaryLeaf != $".gigachat-write-{fileId}.tmp"
            || journal.BackupLeaf != $".gigachat-write-{fileId}.bak")
            throw new InvalidDataException("Журнал записи не прошёл проверку.");
        string root = ValidateDirectory(journal.WorkingFolder, "Рабочая папка");
        if (root.Equals(recoveryDirectory, StringComparison.OrdinalIgnoreCase)
            || IsWithin(root, recoveryDirectory) || IsWithin(recoveryDirectory, root))
            throw new InvalidDataException("Путь журнала записи пересекается с папкой runtime.");
        string[] parts = ValidateRelativeFilePath(journal.RelativePath);
        string target = Path.GetFullPath(Path.Combine(root, Path.Combine(parts)));
        if (!IsWithin(target, root)) throw new InvalidDataException("Путь журнала записи выходит за границы проекта.");
        string parent = Path.GetDirectoryName(target) ?? throw new InvalidDataException("Путь журнала записи некорректен.");
        string temporary = Path.Combine(parent, journal.TemporaryLeaf);
        string backup = Path.Combine(parent, journal.BackupLeaf);
        EnsureNoReparseComponents(root);
        EnsureNoReparseComponents(parent);
        EnsureNoReparseComponents(target);
        EnsureNoReparseComponents(temporary);
        EnsureNoReparseComponents(backup);
        if (File.Exists(backup))
        {
            if (!journal.TargetExisted || Directory.Exists(target))
                throw new InvalidDataException("Журнал записи содержит неожиданный backup.");
            File.Move(backup, target, overwrite: true);
        }
        if (File.Exists(temporary)) File.Delete(temporary);
        File.Delete(path);
    }

    private static string[] ValidateRelativeFilePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > MaxRelativePathChars
            || Path.IsPathRooted(value) || value.Contains(':') || value.Contains('\0'))
            throw new InvalidDataException("Некорректный относительный путь.");
        string[] parts = value.Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.None);
        if (parts.Any(part => string.IsNullOrWhiteSpace(part) || part is "." or ".."
            || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
            throw new InvalidDataException("Некорректный относительный путь.");
        return parts;
    }

    private static void Run(string recoveryDirectoryInput)
    {
        if (string.IsNullOrWhiteSpace(recoveryDirectoryInput) || !Path.IsPathFullyQualified(recoveryDirectoryInput))
            throw new InvalidDataException("Некорректная папка runtime.");
        string recoveryCandidate = Path.GetFullPath(recoveryDirectoryInput);
        RunRequest request = JsonSerializer.Deserialize<RunRequest>(ReadBounded(Console.In, MaxRequestChars), JsonOptions)
            ?? throw new InvalidDataException("Пустой запрос.");
        string workingFolder = ValidateDirectory(request.WorkingFolder, "Рабочая папка");
        if (workingFolder.Equals(recoveryCandidate, StringComparison.OrdinalIgnoreCase)
            || IsWithin(workingFolder, recoveryCandidate) || IsWithin(recoveryCandidate, workingFolder))
            throw new InvalidDataException("Рабочая папка пересекается с папкой runtime.");
        if (string.IsNullOrWhiteSpace(request.Script) || request.Script.Length > MaxScriptChars)
            throw new InvalidDataException("Некорректный размер команды.");
        byte[]? inputData = null;
        if (request.InputDataBase64 is not null)
        {
            int maxEncodedLength = checked(((MaxInputBytes + 2) / 3) * 4);
            if (request.InputDataBase64.Length > maxEncodedLength)
                throw new InvalidDataException("Входные данные превышают лимит 1 МиБ.");
            inputData = Convert.FromBase64String(request.InputDataBase64);
            if (inputData.Length > MaxInputBytes)
                throw new InvalidDataException("Входные данные превышают лимит 1 МиБ.");
        }
        if (request.TimeoutMs is < 100 or > MaxTimeoutMs)
            throw new InvalidDataException("Некорректный таймаут.");
        if (request.MaxOutputBytes is < 1 or > MaxOutputBytes)
            throw new InvalidDataException("Некорректный лимит вывода.");

        string recoveryDirectory = PrepareRecoveryDirectory(recoveryCandidate);
        using FileStream runtimeLock = AcquireRuntimeLock(recoveryDirectory, MaxRunLockWaitMs);
        workingFolder = ValidateDirectory(request.WorkingFolder, "Рабочая папка");
        Recover(recoveryDirectory);
        string runId = Guid.NewGuid().ToString("N");
        string profileName = ProfilePrefix + runId;
        string sessionDirectory = Path.Combine(recoveryDirectory, "run-" + runId);
        string scriptPath = Path.Combine(sessionDirectory, "command.ps1");
        string toolInputPath = Path.Combine(sessionDirectory, "input.bin");

        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr jobHandle = IntPtr.Zero;
        IntPtr processHandle = IntPtr.Zero;
        IntPtr threadHandle = IntPtr.Zero;
        SafeFileHandle? stdoutRead = null;
        SafeFileHandle? stdoutWrite = null;
        SafeFileHandle? stderrRead = null;
        SafeFileHandle? stderrWrite = null;
        string? journalPath = null;
        bool profileCreated = false;
        bool processFinished = false;
        bool timedOut = false;
        bool outputLimited = false;
        int exitCode = -1;
        byte[] stdout = Array.Empty<byte>();
        byte[] stderr = Array.Empty<byte>();
        string stage = "create isolated process";
        try
        {
            stage = "create session directory";
            Directory.CreateDirectory(sessionDirectory);
            stage = "validate session directory";
            EnsureNoReparseComponents(sessionDirectory);
            if (inputData is not null)
            {
                stage = "materialize bounded input";
                File.WriteAllBytes(toolInputPath, inputData);
                Array.Clear(inputData);
            }
            stage = "write PowerShell script";
            string script = "$ErrorActionPreference = 'Stop'\r\n"
                + "$utf8 = [System.Text.UTF8Encoding]::new($false)\r\n"
                + "[Console]::OutputEncoding = $utf8\r\n$OutputEncoding = $utf8\r\n"
                + request.Script;
            File.WriteAllText(scriptPath, script, new UTF8Encoding(true));
            stage = "create AppContainer profile";
            int createResult = Native.CreateAppContainerProfile(profileName, profileName,
                "Temporary GigaChat Agents local tool", IntPtr.Zero, 0, out appContainerSid);
            if (createResult < 0) throw new Win32Exception(createResult, "CreateAppContainerProfile");
            profileCreated = true;
            stage = "read AppContainer SID";
            string sidText = new SecurityIdentifier(appContainerSid).Value;

            stage = "prepare ACL journal";
            List<AclEntry> aclEntries = BuildAclEntries(workingFolder, recoveryDirectory, sessionDirectory);
            journalPath = Path.Combine(recoveryDirectory, "acl-" + runId + ".json");
            WriteJournal(journalPath, new AclJournal(profileName, sidText, aclEntries));

            stage = "grant temporary project boundary";
            foreach (AclEntry entry in aclEntries) AddRule(entry, sidText);

            string systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string powershellPath = Path.Combine(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(powershellPath)) throw new FileNotFoundException("Windows PowerShell 5.1 is unavailable.");

            stage = "prepare bounded output pipes";
            CreatePipe(out stdoutRead, out stdoutWrite);
            CreatePipe(out stderrRead, out stderrWrite);
            IntPtr attributeList = IntPtr.Zero;
            IntPtr capabilitiesPointer = IntPtr.Zero;
            IntPtr handleListPointer = IntPtr.Zero;
            IntPtr environmentPointer = IntPtr.Zero;
            try
            {
                stage = "prepare AppContainer process attributes";
                attributeList = CreateAttributeList(2);
                var capabilities = new SecurityCapabilities
                {
                    AppContainerSid = appContainerSid,
                    Capabilities = IntPtr.Zero,
                    CapabilityCount = 0,
                    Reserved = 0,
                };
                capabilitiesPointer = Marshal.AllocHGlobal(Marshal.SizeOf<SecurityCapabilities>());
                Marshal.StructureToPtr(capabilities, capabilitiesPointer, false);
                UpdateAttribute(attributeList, ProcThreadAttributeSecurityCapabilities,
                    capabilitiesPointer, (UIntPtr)Marshal.SizeOf<SecurityCapabilities>());

                handleListPointer = Marshal.AllocHGlobal(IntPtr.Size * 2);
                Marshal.WriteIntPtr(handleListPointer, 0, stdoutWrite.DangerousGetHandle());
                Marshal.WriteIntPtr(handleListPointer, IntPtr.Size, stderrWrite.DangerousGetHandle());
                UpdateAttribute(attributeList, ProcThreadAttributeHandleList, handleListPointer,
                    (UIntPtr)(IntPtr.Size * 2));

                string commandLine = $"\"{powershellPath}\" -NoLogo -NoProfile -NonInteractive -File \"{scriptPath}\"";
                string environment = BuildEnvironment(systemRoot, sessionDirectory, toolInputPath, workingFolder);
                environmentPointer = Marshal.StringToHGlobalUni(environment);
                var startup = new StartupInfoEx
                {
                    StartupInfo = new StartupInfo
                    {
                        Size = Marshal.SizeOf<StartupInfoEx>(),
                        Flags = StartfUseStdHandles,
                        StdInput = IntPtr.Zero,
                        StdOutput = stdoutWrite.DangerousGetHandle(),
                        StdError = stderrWrite.DangerousGetHandle(),
                    },
                    AttributeList = attributeList,
                };
                stage = "launch PowerShell in AppContainer";
                if (!Native.CreateProcessW(powershellPath, new StringBuilder(commandLine), IntPtr.Zero,
                        IntPtr.Zero, true,
                        ExtendedStartupInfoPresent | CreateUnicodeEnvironment | CreateNoWindow | CreateSuspended,
                        environmentPointer, workingFolder, ref startup, out ProcessInformation processInfo))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW(AppContainer)");
                processHandle = processInfo.Process;
                threadHandle = processInfo.Thread;
                stdoutWrite.Dispose(); stdoutWrite = null;
                stderrWrite.Dispose(); stderrWrite = null;

                stage = "assign bounded process tree";
                jobHandle = Native.CreateJobObject(IntPtr.Zero, null);
                if (jobHandle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
                var jobLimits = new JobObjectExtendedLimitInformation
                {
                    BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = JobObjectLimitKillOnJobClose },
                };
                if (!Native.SetInformationJobObject(jobHandle, JobObjectExtendedLimitInfoClass, ref jobLimits,
                        (uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>()))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject");
                if (!Native.AssignProcessToJobObject(jobHandle, processHandle))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject");
                if (Native.ResumeThread(threadHandle) == uint.MaxValue)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");

                stage = "run with timeout and output cap";
                (stdout, stderr, timedOut, outputLimited, exitCode) = CaptureProcess(
                    processHandle, ref jobHandle, stdoutRead, stderrRead, request.TimeoutMs, request.MaxOutputBytes);
                processFinished = true;
            }
            finally
            {
                if (jobHandle != IntPtr.Zero) { Native.CloseHandle(jobHandle); jobHandle = IntPtr.Zero; }
                if (environmentPointer != IntPtr.Zero) Marshal.FreeHGlobal(environmentPointer);
                if (handleListPointer != IntPtr.Zero) Marshal.FreeHGlobal(handleListPointer);
                if (capabilitiesPointer != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesPointer);
                if (attributeList != IntPtr.Zero)
                {
                    Native.DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
            }

            stage = "restore temporary project boundary";
            if (journalPath is not null) CleanupJournal(journalPath);
            journalPath = null;
            profileCreated = false;
            DeleteDirectorySafely(sessionDirectory, recoveryDirectory);
            Console.WriteLine(JsonSerializer.Serialize(new RunResult(exitCode,
                Decode(stdout), Decode(stderr), timedOut, outputLimited)));
        }
        catch (Exception error)
        {
            if (journalPath is not null)
            {
                if (File.Exists(journalPath))
                {
                    try { CleanupJournal(journalPath); journalPath = null; profileCreated = false; }
                    catch { /* Journal stays for fail-closed recovery on the next launch. */ }
                }
                else journalPath = null;
            }
            try { DeleteDirectorySafely(sessionDirectory, recoveryDirectory); } catch { /* Keep artifacts for recovery if paths changed. */ }
            throw new InvalidOperationException($"{stage}: {error.Message}", error);
        }
        finally
        {
            if (jobHandle != IntPtr.Zero) Native.CloseHandle(jobHandle);
            if (processHandle != IntPtr.Zero && !processFinished)
            {
                Native.TerminateProcess(processHandle, 127);
                Native.WaitForSingleObject(processHandle, 5000);
            }
            if (threadHandle != IntPtr.Zero) Native.CloseHandle(threadHandle);
            if (processHandle != IntPtr.Zero) Native.CloseHandle(processHandle);
            stdoutRead?.Dispose(); stdoutWrite?.Dispose();
            stderrRead?.Dispose(); stderrWrite?.Dispose();
            if (profileCreated && journalPath is null)
            {
                int deleteResult = Native.DeleteAppContainerProfile(profileName);
                if (deleteResult < 0)
                    throw new Win32Exception(deleteResult, "DeleteAppContainerProfile");
            }
            if (appContainerSid != IntPtr.Zero) Native.FreeSid(appContainerSid);
        }
    }

    private static (byte[] stdout, byte[] stderr, bool timedOut, bool outputLimited, int exitCode) CaptureProcess(
        IntPtr process, ref IntPtr job, SafeFileHandle stdoutRead, SafeFileHandle stderrRead, int timeoutMs, int maxOutputBytes)
    {
        using var stdoutStream = new FileStream(stdoutRead, FileAccess.Read, 4096, isAsync: false);
        using var stderrStream = new FileStream(stderrRead, FileAccess.Read, 4096, isAsync: false);
        int total = 0;
        int outputLimit = 0;
        var stdoutBuffer = new MemoryStream();
        var stderrBuffer = new MemoryStream();
        Task stdoutTask = Task.Run(() => Pump(stdoutStream, stdoutBuffer, maxOutputBytes, ref total, ref outputLimit));
        Task stderrTask = Task.Run(() => Pump(stderrStream, stderrBuffer, maxOutputBytes, ref total, ref outputLimit));
        bool timedOut = false;
        bool outputLimited = false;
        int exitCode = -1;
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            if (Volatile.Read(ref outputLimit) != 0)
            {
                outputLimited = true;
                break;
            }
            uint result = Native.WaitForSingleObject(process, 50);
            if (result == WaitObject0)
            {
                Native.GetExitCodeProcess(process, out uint code);
                exitCode = unchecked((int)code);
                break;
            }
            if (result != WaitTimeout) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
            if (DateTime.UtcNow >= deadline) { timedOut = true; break; }
        }
        if (timedOut || outputLimited)
        {
            Native.CloseHandle(job);
            job = IntPtr.Zero;
            if (Native.WaitForSingleObject(process, 5000) != WaitObject0)
            {
                Native.TerminateProcess(process, timedOut ? 124u : 125u);
                Native.WaitForSingleObject(process, 5000);
            }
        }
        else
        {
            Native.CloseHandle(job);
            job = IntPtr.Zero;
        }
        if (!stdoutTask.Wait(TimeSpan.FromSeconds(5)) || !stderrTask.Wait(TimeSpan.FromSeconds(5)))
            throw new TimeoutException("Bounded PowerShell output did not close.");
        outputLimited |= Volatile.Read(ref outputLimit) != 0;
        return (stdoutBuffer.ToArray(), stderrBuffer.ToArray(), timedOut, outputLimited, exitCode);
    }

    private static void Pump(Stream input, MemoryStream output, int maxOutputBytes, ref int total, ref int outputLimit)
    {
        byte[] buffer = new byte[4096];
        while (true)
        {
            int count = input.Read(buffer, 0, buffer.Length);
            if (count == 0) return;
            int before = Interlocked.Add(ref total, count) - count;
            int remaining = Math.Max(0, maxOutputBytes - before);
            int keep = Math.Min(count, remaining);
            if (keep > 0) output.Write(buffer, 0, keep);
            if (keep != count) Interlocked.Exchange(ref outputLimit, 1);
        }
    }

    private static string PrepareRecoveryDirectory(string input)
    {
        if (string.IsNullOrWhiteSpace(input) || !Path.IsPathFullyQualified(input))
            throw new InvalidDataException("Некорректная папка runtime.");
        string full = Path.GetFullPath(input);
        string? parent = Path.GetDirectoryName(full);
        if (parent is null) throw new InvalidDataException("Некорректная папка runtime.");
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException("Папка родителя runtime не найдена.");
        EnsureNoReparseComponents(parent);
        Directory.CreateDirectory(full);
        return ValidateDirectory(full, "Папка runtime");
    }

    private static string ValidateDirectory(string input, string label)
    {
        if (string.IsNullOrWhiteSpace(input) || !Path.IsPathFullyQualified(input))
            throw new InvalidDataException($"{label} недоступна.");
        string full = Path.GetFullPath(input);
        if (!Directory.Exists(full)) throw new DirectoryNotFoundException($"{label} недоступна.");
        EnsureNoReparseComponents(full);
        string driveRoot = Path.GetPathRoot(full) ?? string.Empty;
        if (driveRoot.Length != 3 || full.Equals(driveRoot, StringComparison.OrdinalIgnoreCase)
            || new DriveInfo(driveRoot).DriveType == DriveType.Network)
            throw new InvalidDataException("Поддерживаются только папки на локальном диске.");
        return full.TrimEnd(Path.DirectorySeparatorChar);
    }

    private static List<AclEntry> BuildAclEntries(string workingFolder, string recoveryDirectory, string sessionDirectory)
    {
        string projectParent = Path.GetDirectoryName(workingFolder)
            ?? throw new InvalidDataException("Рабочая папка недоступна.");
        return new List<AclEntry>
        {
            new(projectParent, (int)(FileSystemRights.Traverse | FileSystemRights.Synchronize), 0, 0),
            new(workingFolder, (int)(FileSystemRights.Modify | FileSystemRights.ReadAndExecute),
                (int)(InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit), 0),
            new(recoveryDirectory, (int)(FileSystemRights.Traverse | FileSystemRights.Synchronize), 0, 0),
            new(sessionDirectory, (int)(FileSystemRights.Modify | FileSystemRights.ReadAndExecute),
                (int)(InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit), 0),
        }.DistinctBy(entry => (entry.Path, entry.Rights, entry.Inheritance, entry.Propagation)).ToList();
    }

    private static void AddRule(AclEntry entry, string sidText)
    {
        EnsureNoReparseComponents(entry.Path);
        var directory = new DirectoryInfo(entry.Path);
        DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
        var rule = CreateRule(entry, sidText);
        security.AddAccessRule(rule);
        directory.SetAccessControl(security);
    }

    private static void RemoveRule(AclEntry entry, string sidText)
    {
        if (!Directory.Exists(entry.Path)) return;
        EnsureNoReparseComponents(entry.Path);
        var directory = new DirectoryInfo(entry.Path);
        DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
        FileSystemAccessRule expected = CreateRule(entry, sidText);
        bool present = security.GetAccessRules(true, false, typeof(SecurityIdentifier))
            .OfType<FileSystemAccessRule>()
            .Any(rule => rule.IdentityReference.Equals(expected.IdentityReference)
                && rule.AccessControlType == expected.AccessControlType
                && rule.FileSystemRights == expected.FileSystemRights
                && rule.InheritanceFlags == expected.InheritanceFlags
                && rule.PropagationFlags == expected.PropagationFlags);
        if (present)
        {
            security.RemoveAccessRuleSpecific(expected);
            directory.SetAccessControl(security);
        }
    }

    private static FileSystemAccessRule CreateRule(AclEntry entry, string sidText) => new(
        new SecurityIdentifier(sidText), (FileSystemRights)entry.Rights,
        (InheritanceFlags)entry.Inheritance, (PropagationFlags)entry.Propagation, AccessControlType.Allow);

    private static void WriteJournal(string path, AclJournal journal)
    {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(journal), new UTF8Encoding(false));
        using (var stream = new FileStream(temporary, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) stream.Flush(true);
        File.Move(temporary, path, overwrite: true);
    }

    private static void CleanupJournal(string path)
    {
        if (!File.Exists(path)) return;
        EnsureNoReparseComponents(path);
        AclJournal journal = JsonSerializer.Deserialize<AclJournal>(File.ReadAllText(path), JsonOptions)
            ?? throw new InvalidDataException("Повреждён журнал восстановления.");
        string profileId = journal.ProfileName.StartsWith(ProfilePrefix, StringComparison.Ordinal)
            ? journal.ProfileName[ProfilePrefix.Length..] : string.Empty;
        if (!Guid.TryParseExact(profileId, "N", out _)
            || !SidMatchesProfile(journal.ProfileName, journal.ProfileSid)
            || journal.Entries.Count != 4)
            throw new InvalidDataException("Журнал восстановления не прошёл проверку.");
        string recoveryDirectory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        string sessionDirectory = Path.Combine(recoveryDirectory, "run-" + profileId);
        string workFolder = Path.GetFullPath(journal.Entries[1].Path);
        List<AclEntry> expectedEntries = BuildAclEntries(workFolder, recoveryDirectory, sessionDirectory);
        if (!journal.Entries.SequenceEqual(expectedEntries))
            throw new InvalidDataException("Путь журнала восстановления не прошёл проверку.");
        foreach (AclEntry entry in journal.Entries.AsEnumerable().Reverse()) RemoveRule(entry, journal.ProfileSid);
        int deleteResult = Native.DeleteAppContainerProfile(journal.ProfileName);
        if (deleteResult < 0 && deleteResult != unchecked((int)0x80070002))
            throw new Win32Exception(deleteResult, "DeleteAppContainerProfile");
        DeleteDirectorySafely(sessionDirectory, recoveryDirectory);
        File.Delete(path);
    }

    private static void Recover(string recoveryDirectory)
    {
        string directory = Path.GetFullPath(recoveryDirectory);
        EnsureNoReparseComponents(directory);
        foreach (string journal in Directory.EnumerateFiles(directory, "write-*.json", SearchOption.TopDirectoryOnly))
        {
            string id = Path.GetFileNameWithoutExtension(journal)[6..];
            if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("Неизвестный журнал записи.");
            RecoverBrokerWriteJournal(journal, directory);
        }
        foreach (string temporary in Directory.EnumerateFiles(directory, "write-*.json.tmp", SearchOption.TopDirectoryOnly))
        {
            EnsureNoReparseComponents(temporary);
            string id = Path.GetFileName(temporary)[6..].Split('.')[0];
            if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("Неизвестный временный журнал записи.");
            File.Delete(temporary);
        }
        foreach (string journal in Directory.EnumerateFiles(directory, "acl-*.json", SearchOption.TopDirectoryOnly))
        {
            string name = Path.GetFileNameWithoutExtension(journal);
            string id = name.StartsWith("acl-", StringComparison.Ordinal) ? name[4..] : string.Empty;
            if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("Неизвестный журнал runtime.");
            CleanupJournal(journal);
        }
        foreach (string temporary in Directory.EnumerateFiles(directory, "acl-*.json.tmp", SearchOption.TopDirectoryOnly))
        {
            // A journal is made durable before any ACL is changed, so an incomplete temp has no matching grants.
            EnsureNoReparseComponents(temporary);
            string id = Path.GetFileName(temporary)[4..].Split('.')[0];
            if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("Неизвестный временный журнал runtime.");
            File.Delete(temporary);
        }
        foreach (string session in Directory.EnumerateDirectories(directory, "run-*", SearchOption.TopDirectoryOnly))
        {
            EnsureNoReparseComponents(session);
            string id = Path.GetFileName(session)[4..];
            if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("Неизвестная временная папка runtime.");
            string journal = Path.Combine(directory, $"acl-{id}.json");
            if (File.Exists(journal)) throw new InvalidDataException("Журнал runtime не был восстановлен.");
            int deleteResult = Native.DeleteAppContainerProfile(ProfilePrefix + id);
            if (deleteResult < 0 && deleteResult != unchecked((int)0x80070002))
                throw new Win32Exception(deleteResult, "DeleteAppContainerProfile(orphan)");
            DeleteDirectorySafely(session, directory);
        }
    }

    private static FileStream AcquireRuntimeLock(string recoveryDirectory, int waitTimeoutMs)
    {
        string lockPath = Path.Combine(recoveryDirectory, "runtime.lock");
        EnsureNoReparseComponents(lockPath);
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(waitTimeoutMs);
        while (true)
        {
            try { return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.WriteThrough); }
            catch (IOException error) when ((error.HResult & 0xFFFF) is 32 or 33)
            {
                if (DateTime.UtcNow >= deadline) throw new TimeoutException("Другой local runtime не освободил блокировку.");
                Thread.Sleep(50);
            }
        }
    }

    private static void EnsureNoReparseComponents(string path)
    {
        string full = Path.GetFullPath(path);
        string root = Path.GetPathRoot(full) ?? throw new InvalidDataException("Некорректный путь.");
        string current = root;
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Путь содержит reparse point.");
        foreach (string component in Path.GetRelativePath(root, full).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (component.Length == 0) continue;
            current = Path.Combine(current, component);
            if (Directory.Exists(current) || File.Exists(current))
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Путь содержит reparse point.");
        }
    }

    private static bool IsWithin(string path, string parent)
    {
        string relative = Path.GetRelativePath(parent, path);
        return relative != "." && relative != ".."
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !Path.IsPathFullyQualified(relative);
    }

    private static string BuildEnvironment(string systemRoot, string temp, string toolInputPath, string projectRoot)
    {
        string drive = Path.GetPathRoot(temp) ?? throw new InvalidDataException("Runtime path has no drive root.");
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["APPDATA"] = temp,
            ["ComSpec"] = Path.Combine(systemRoot, "System32", "cmd.exe"),
            ["GIGACHAT_LOCAL_TOOL_INPUT"] = toolInputPath,
            ["GIGACHAT_PROJECT_ROOT"] = projectRoot,
            ["HOMEDRIVE"] = drive.TrimEnd(Path.DirectorySeparatorChar),
            ["HOMEPATH"] = temp[(drive.Length - 1)..],
            ["LOCALAPPDATA"] = temp,
            ["PATH"] = Path.Combine(systemRoot, "System32"),
            ["SystemDrive"] = drive.TrimEnd(Path.DirectorySeparatorChar),
            ["SystemRoot"] = systemRoot,
            ["TEMP"] = temp,
            ["TMP"] = temp,
            ["USERPROFILE"] = temp,
            ["WINDIR"] = systemRoot,
        };
        return string.Join('\0', values.Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0";
    }

    private static IntPtr CreateAttributeList(int attributeCount)
    {
        UIntPtr size = UIntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
        int error = Marshal.GetLastWin32Error();
        if (error != ErrorInsufficientBuffer) throw new Win32Exception(error, "InitializeProcThreadAttributeList(size)");
        IntPtr list = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
        if (!Native.InitializeProcThreadAttributeList(list, attributeCount, 0, ref size))
        {
            int initializeError = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(list);
            throw new Win32Exception(initializeError, "InitializeProcThreadAttributeList");
        }
        return list;
    }

    private static void UpdateAttribute(IntPtr list, nuint attribute, IntPtr value, UIntPtr size)
    {
        if (!Native.UpdateProcThreadAttribute(list, 0, attribute, value, size, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute");
    }

    private static void CreatePipe(out SafeFileHandle read, out SafeFileHandle write)
    {
        var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), InheritHandle = true };
        if (!Native.CreatePipe(out read, out write, ref attributes, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe");
        if (!Native.SetHandleInformation(read, HandleFlagInherit, 0))
        {
            int error = Marshal.GetLastWin32Error();
            read.Dispose(); write.Dispose();
            throw new Win32Exception(error, "SetHandleInformation");
        }
    }

    private static void DeleteDirectorySafely(string path, string allowedRoot)
    {
        if (!Directory.Exists(path)) return;
        string full = Path.GetFullPath(path);
        if (!IsWithin(full, Path.GetFullPath(allowedRoot)) || full.Equals(Path.GetFullPath(allowedRoot), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Папка временного runtime выходит за разрешённую границу.");
        EnsureNoReparseComponents(full);
        foreach (string child in Directory.EnumerateFileSystemEntries(full))
        {
            FileAttributes attributes = File.GetAttributes(child);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Временная папка runtime содержит reparse point.");
            if ((attributes & FileAttributes.Directory) != 0) DeleteDirectorySafely(child, full);
            else File.Delete(child);
        }
        Directory.Delete(full, recursive: false);
    }

    private static bool SidMatchesProfile(string profileName, string value)
    {
        IntPtr expectedSid = IntPtr.Zero;
        try
        {
            if (Native.DeriveAppContainerSidFromAppContainerName(profileName, out expectedSid) < 0 || expectedSid == IntPtr.Zero)
                return false;
            return new SecurityIdentifier(expectedSid).Value.Equals(value, StringComparison.Ordinal);
        }
        catch (SystemException) { return false; }
        finally { if (expectedSid != IntPtr.Zero) Native.FreeSid(expectedSid); }
    }

    private static string Decode(byte[] bytes) => Encoding.UTF8.GetString(bytes);

    private static string ReadBounded(TextReader input, int maxChars)
    {
        var value = new StringBuilder();
        char[] buffer = new char[4096];
        int count;
        while ((count = input.Read(buffer, 0, Math.Min(buffer.Length, maxChars + 1 - value.Length))) > 0)
        {
            value.Append(buffer, 0, count);
            if (value.Length > maxChars) throw new InvalidDataException("Запрос слишком велик.");
        }
        return value.ToString();
    }

    private static void WriteError(string message, int code, string? stage = null) =>
        Console.WriteLine(JsonSerializer.Serialize(new ErrorResult(message, code, stage)));

    private sealed record RunRequest(string WorkingFolder, string Script, int TimeoutMs, int MaxOutputBytes,
        string? InputDataBase64 = null);
    private sealed record RunResult(int ExitCode, string Stdout, string Stderr, bool TimedOut, bool OutputLimited);
    private sealed record ErrorResult(string Error, int Code, string? Stage = null);
    private sealed record BrokerWriteRequest(string WorkingFolder, string RelativePath, string ContentsBase64);
    private sealed record BrokerWriteResult(int Bytes, bool ReplacedExisting);
    private sealed record BrokerWriteJournal(string Id, string WorkingFolder, string RelativePath,
        bool TargetExisted, string TemporaryLeaf, string BackupLeaf);
    private sealed record SecuritySnapshot(string? Owner, string? Group, string? Dacl, string? Label);
    private sealed record DeleteAppDataRequest(string UserDataPath);
    private sealed record DeleteAppDataReady(bool Ready, uint ParentProcessId, bool TargetValidated);
    private sealed record AclJournal(string ProfileName, string ProfileSid, List<AclEntry> Entries);
    private sealed record AclEntry(string Path, int Rights, int Inheritance, int Propagation);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string? Reserved;
        public string? Desktop;
        public string? Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process; public IntPtr Thread; public uint ProcessId; public uint ThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint UsageCount;
        public uint ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId;
        public uint ThreadCount;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string? ExecutableFile;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Length; public IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectIoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public JobObjectIoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private static class Native
    {
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        internal static extern int CreateAppContainerProfile(string name, string displayName, string description,
            IntPtr capabilities, uint capabilityCount, out IntPtr appContainerSid);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        internal static extern int DeleteAppContainerProfile(string name);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        internal static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr appContainerSid);
        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern IntPtr FreeSid(IntPtr sid);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint GetNamedSecurityInfoW(string objectName, uint objectType, uint securityInfo,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr securityDescriptor,
            uint revision, uint securityInfo, out IntPtr stringSecurityDescriptor, out uint stringLength);
        [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList, int attributeCount, uint flags, ref UIntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList, uint flags, nuint attribute, IntPtr value, UIntPtr size,
            IntPtr previousValue, IntPtr returnSize);
        [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcessW(string applicationName,
            StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment,
            string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(
            IntPtr job, int informationClass, ref JobObjectExtendedLimitInformation information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryFullProcessImageNameW(IntPtr process,
            uint flags, StringBuilder executableName, ref uint size);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(
            out SafeFileHandle readPipe, out SafeFileHandle writePipe, ref SecurityAttributes attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(
            SafeFileHandle handle, uint mask, uint flags);
    }
}

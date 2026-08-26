using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;

// The only C# in the playground. It exists because [JSExport] is implemented
// by a Roslyn source generator that emits a module initializer and an unsafe
// JSMarshalerArgument* wrapper, neither of which ghūl can currently produce.
//
// The intent is for this to shrink to a one-line delegation into
// ../runner/src/runner.ghul, which already implements all of this in ghūl and
// compiles cleanly on its own. That is blocked on a C#-referencing-ghūl
// metadata problem -- see docs/claude/playground-design.md.

Console.WriteLine("ghūl wasm shim ready");

partial class GhulRunner
{
    // Bytes arrive base64-encoded rather than as a byte[] so the interop
    // surface stays to plain strings, which marshal the same way everywhere.
    [JSExport]
    internal static string Run(string base64)
    {
        try
        {
            return Invoke(Assembly.Load(Convert.FromBase64String(base64)));
        }
        catch (Exception e)
        {
            return $"host error: {e.GetType().Name}: {e.Message}";
        }
    }

    // Console is redirected for the duration of the call: without this the
    // program's output goes to the browser console, where the page cannot
    // show it.
    private static string Invoke(Assembly assembly)
    {
        var entry = assembly.EntryPoint;

        if (entry is null)
        {
            return "assembly has no entry point";
        }

        var writer = new StringWriter();
        var previous = Console.Out;

        Console.SetOut(writer);

        try
        {
            var arguments = entry.GetParameters().Length == 0
                ? null
                : new object[] { Array.Empty<string>() };

            var result = entry.Invoke(null, arguments);

            if (result is not null)
            {
                writer.WriteLine($"[exit status {result}]");
            }
        }
        catch (TargetInvocationException e)
        {
            writer.WriteLine(DescribeFailure(e.InnerException));
        }
        finally
        {
            Console.SetOut(previous);
        }

        return writer.ToString();
    }

    // The browser host has no stdin: reading it throws PlatformNotSupportedException
    // with a generic "not supported on this platform" message that gives no hint why.
    // A program that never called Console.ReadLine can still hit this exception type
    // for an unrelated reason, so the stack trace - not just the exception type - is
    // what tells the two apart.
    private static string DescribeFailure(Exception e)
    {
        if (e is PlatformNotSupportedException && e.StackTrace?.Contains("Console") == true)
        {
            return "[unhandled: this program reads from standard input, which the playground does not support]";
        }

        return $"[unhandled: {e?.GetType().Name}: {e?.Message}]";
    }
}

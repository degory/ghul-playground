using System;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;

// The only C# in the playground, and as little of it as there can be. Loading
// the program, running it and capturing its output are all in
// ../runner/src/runner.ghul; this exists for two reasons that ghūl cannot
// currently cover.
//
// [JSExport] is implemented by a Roslyn source generator that emits a module
// initializer and an unsafe JSMarshalerArgument* wrapper. ghūl can emit the
// attribute but not the generated code, so the browser has no way to call in.
//
// And the call out goes through reflection rather than by naming
// Playground.RUNNER, because a ghūl assembly cannot be bound against from C#:
// every assembly the compiler emits records a reference to System.Runtime
// 8.0.0.0, which is not a version that exists, and Roslyn refuses the
// reference with CS0012 the moment C# names a type from it. Reflection is
// resolved by the runtime rather than by Roslyn and is unaffected.

Console.WriteLine("ghūl wasm shim ready");

partial class GhulRunner
{
    // Looked up once. The runner is a compile-time ProjectReference, so the
    // assembly is in the output and beside this one whether or not anything
    // names it.
    private static readonly Type RunnerType =
        Assembly.Load("runner").GetType("Playground.RUNNER")!;

    private static readonly MethodInfo Runner = RunnerType.GetMethod("run")!;
    private static readonly MethodInfo CellRunner = RunnerType.GetMethod("run_cell")!;
    private static readonly MethodInfo Opener = RunnerType.GetMethod("open_channel")!;

    // The address of the channel's control block, which is how the page
    // watches output appear and hands back a typed line. Everything crossing
    // that boundary crosses through memory rather than through a call - see
    // Playground.CHANNEL for why nothing else would work.
    [JSExport]
    internal static Task<int> OpenChannel() =>
        Task.FromResult((int)Opener.Invoke(null, null)!);

    // Bytes arrive base64-encoded rather than as a byte[] so the interop
    // surface stays to plain strings, which marshal the same way everywhere.
    // What comes back is JSON, so the host's own failure can be told apart
    // from the program's output - see the runner.
    //
    // Two things about the shape. It returns a Task because with threading
    // enabled the browser's main thread cannot call a synchronous C# method at
    // all: the runtime rejects it rather than blocking. And the program itself
    // is put on a pool thread rather than run here, because a program that
    // reads a line blocks the thread it is on until somebody types - which is
    // fine for a pool thread and would be the runtime's own interop thread
    // otherwise.
    [JSExport]
    internal static Task<string> Run(string base64) => Task.Run(() =>
    {
        try
        {
            return (string)Runner.Invoke(null, new object[] { base64 })!;
        }
        catch (Exception e)
        {
            // The runner answers for anything the program did. Reaching here
            // means the host itself failed, so there is no JSON to give back.
            return $"{{\"text\":\"host error: {e.GetType().Name}\"}}";
        }
    });

    // One step of an interactive session: the cell's assembly, and the
    // namespace it was compiled into with `--submission`. Runs on a pool thread
    // for the same reasons Run does; see Playground.RUNNER.run_cell for what
    // comes back.
    [JSExport]
    internal static Task<string> RunCell(string base64, string submission) => Task.Run(() =>
    {
        try
        {
            return (string)CellRunner.Invoke(null, new object[] { base64, submission })!;
        }
        catch (Exception e)
        {
            return $"{{\"text\":\"host error: {e.GetType().Name}\"}}";
        }
    });

    private static readonly Type ReplType =
        Assembly.Load("runner").GetType("Playground.REPL_SESSION")!;

    private static readonly MethodInfo ReplPrepareMethod = ReplType.GetMethod("prepare")!;
    private static readonly MethodInfo ReplAcceptMethod = ReplType.GetMethod("accept")!;
    private static readonly MethodInfo ReplAnalysisMethod = ReplType.GetMethod("analysis")!;

    // The interactive session, around the page's request to the compile
    // service: what to send for a submission, then what to show once the
    // reply is in. See Playground.REPL_SESSION.
    [JSExport]
    internal static Task<string> ReplPrepare(string text) => Task.Run(() =>
    {
        try
        {
            return (string)ReplPrepareMethod.Invoke(null, new object[] { text })!;
        }
        catch (Exception e)
        {
            return $"{{\"error\":\"host error: {e.GetType().Name}\"}}";
        }
    });

    [JSExport]
    internal static Task<string> ReplAnalysis(string text) => Task.Run(() =>
    {
        try
        {
            return (string)ReplAnalysisMethod.Invoke(null, new object[] { text })!;
        }
        catch (Exception e)
        {
            return $"{{\"error\":\"host error: {e.GetType().Name}\"}}";
        }
    });

    [JSExport]
    internal static Task<string> ReplAccept(string reply) => Task.Run(() =>
    {
        try
        {
            return (string)ReplAcceptMethod.Invoke(null, new object[] { reply })!;
        }
        catch (Exception e)
        {
            var inner = e.InnerException ?? e;

            return $"{{\"accepted\":false,\"diagnostics\":[\"host error: {inner.GetType().Name}\"],\"text\":\"\"}}";
        }
    });
}

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
}

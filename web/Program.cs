using System;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;

// The only C# in the playground, and as little of it as there can be. Loading
// the program, running it, capturing its output and collecting the pictures it
// drew are all in ../runner/src/runner.ghul; this exists for two reasons that
// ghūl cannot currently cover.
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
    private static readonly MethodInfo Runner =
        Assembly.Load("runner").GetType("Playground.RUNNER")!.GetMethod("run")!;

    // Bytes arrive base64-encoded rather than as a byte[] so the interop
    // surface stays to plain strings, which marshal the same way everywhere.
    // What comes back is JSON, because a program that draws has two outputs
    // and one channel to return them on - see the runner.
    [JSExport]
    internal static string Run(string base64)
    {
        try
        {
            return (string)Runner.Invoke(null, new object[] { base64 })!;
        }
        catch (Exception e)
        {
            // The runner answers for anything the program did. Reaching here
            // means the host itself failed, so there is no JSON to give back.
            return $"{{\"text\":\"host error: {e.GetType().Name}\",\"images\":[]}}";
        }
    }
}

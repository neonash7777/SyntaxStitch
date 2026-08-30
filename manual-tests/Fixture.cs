using System;
using System.Linq;

internal static class Fixture
{
    internal static int CalculateTotal(int[] values)
    {
        // SyntaxStitch C# target follows.
        return values.Sum();
    }

    internal static void Main() => Console.WriteLine(CalculateTotal(new[] { 4, 8, 15, 16, 23, 42 }));
}
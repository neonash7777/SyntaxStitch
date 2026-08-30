export function calculateTotal(values) {
    // SyntaxStitch JavaScript target follows.
    const total = values.reduce((sum, value) => sum + value, 0);
    return total;
}

console.log(calculateTotal([4, 8, 15, 16, 23, 42]));
def format_total(values: list[int]) -> str:
    # SyntaxStitch Python target is the indentation on the next line.
    total = sum(values)
    return f"Total: {total}"


print(format_total([4, 8, 15, 16, 23, 42]))
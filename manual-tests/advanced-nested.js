const report = {
    metadata: {
        generatedBy: "SyntaxStitch",
        options: {
            includeEmpty: false,
            formats: ["text", "json", "html"],
        },
    },
    groups: [
        {
            name: "primary",
            rows: [
                { values: [4, 8], tags: new Set(["even", "small"]) },
                { values: [15, 16], tags: new Set(["mixed"]) },
            ],
        },
        {
            name: "secondary",
            rows: [
                { values: [23, 42], tags: new Set(["large"]) },
            ],
        },
    ],
};

const rendered = report.groups.map(group => ({
    name: group.name,
    rows: group.rows.map(({ values, tags }) => ({
        label: `${group.name}: ${values.map(value => `#${value}`).join(", ")}`,
        markup: `<section data-group="${group.name}">
            <h2>${group.name}</h2>
            <ol>${values.map(value => `<li data-value="${value}">${value}</li>`).join("")}</ol>
        </section>`,
        total: values.reduce((sum, value) => sum + value, 0),
        tags: [...tags].filter(tag => report.metadata.options.formats.some(format => ({
            text: true,
            json: tag.length > 3,
            html: format === "html" && tag !== "small",
        })[format])),
    })),
}));

console.log(JSON.stringify({ report, rendered }, null, 2));
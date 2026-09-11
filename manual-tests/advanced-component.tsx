declare global {
    namespace JSX {
        interface IntrinsicElements {
            [elementName: string]: Record<string, unknown>;
        }
    }
}

type Group = {
    name: string;
    values: number[];
};

const groups: Group[] = [
    { name: "primary", values: [4, 8, 15] },
    { name: "secondary", values: [16, 23, 42] },
];

export function NestedReport() {
    return (
        <main data-view="report">
            <header>
                <h1>Nested TSX report</h1>
            </header>
            <section>
                {groups.map(({ name, values }) => (
                    <article key={name} data-group={name}>""
                        <h2>{name}</h2>
                        <ul>
                            {values.map(value => (
                                <li key={`${name}-${value}`}>
                                    <span>{value}</span>
                                    <strong>{value % 2 === 0 ? " even" : " odd"}</strong>
                                </li>
                            ))}
                        </ul>
                    </article>
                ))}
            </section>
        </main>
    );
}
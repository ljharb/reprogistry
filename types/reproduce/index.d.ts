declare module 'reproduce' {
    namespace reproduce {
        export type Version = `${number}.${number}.${number}${'' | `-${string}`}` & string;

        type TYear = `${number}${number}${number}${number}`;
        type TMonth = `${number}${number}`;
        type TDay = `${number}${number}`;
        type THours = `${number}${number}`;
        type TMinutes = `${number}${number}`;
        type TSeconds = `${number}${number}`;
        type TMilliseconds = `${number}${number}${number}`;

        /** Represent a string like `2021-01-08` */
        type TDateISODate = `${TYear}-${TMonth}-${TDay}`;

        /** Represent a string like `14:42:34.678` */
        type TDateISOTime = `${THours}:${TMinutes}:${TSeconds}.${TMilliseconds}`;

        /**
         * Represent a string like `2021-01-08T14:42:34.678Z` (format: ISO 8601).
         *
         * It is not possible to type more precisely (list every possible values for months, hours etc) as
         * it would result in a warning from TypeScript:
         * "Expression produces a union type that is too complex to represent. ts(2590)
         */
        type TDateISO = `${TDateISODate}T${TDateISOTime}Z`;

        type ReproduceStrategy = {
            npm: {
                getVersion: () => Version;
                install: <T extends string>(dir: T) => `cd ${T} && npm install --no-audit --no-fund --silent >/dev/null`;
                pack: <T extends string>(dir: T) => ({
                    command: `cd ${T} && npm pack --dry-run --json`,
                    parseResult: (output: string) => object
                });
            };
        };

        export type ReproduceResult = {
            reproduceVersion: Version;
            timestamp: TDateISO;
            os: typeof process.platform;
            arch: typeof process.arch;
            strategy: `${keyof ReproduceStrategy}:${Version}`;
            reproduced: boolean;
            attested: boolean;
            package: {
                spec: string;
                version: Version;
                location: string;
                integrity: string;
            };
            source: {
                spec: string;
                location: string;
                integrity: string;
            };
        };

        type ReproduceCache = {
            spec?: string;
            sourceSpec?: string;
            results: { // TODO
                [k in string]?: false | ReproduceResult;
            };
        };

        export type ReproduceOptions = {
            cache?: ReproduceCache;
            cacheDir?: string;
            cacheFile?: string;
            strategy?: keyof ReproduceStrategy;

        };
    }

    export function reproduce(spec: string, opts?: reproduce.ReproduceOptions): Promise<reproduce.ReproduceResult[]>;
}
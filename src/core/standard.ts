// The Standard Schema v1 interface (https://standardschema.dev), declared here so the library
// imports no validator. A Zod 4 schema, or any other validator's that implements it, satisfies it
// as it is.

/** A schema of any validator that implements Standard Schema v1: what an entity's key and carried
 *  attributes, a relation's link attributes and a field's value are declared with. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** the validator's own entry point; the run calls `validate` */
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** What a Standard Schema's `validate` returns: the parsed value, or the issues. The run keeps
 *  neither issue messages nor paths, which may quote the value. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
      }>;
    };

/** A schema whose parsed value is `T`, whatever it accepts. */
export type Schema<T> = StandardSchemaV1<unknown, T>;

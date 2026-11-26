type TupleShape<T extends readonly unknown[]> =
  T extends readonly [] ? readonly []
  : T extends readonly [infer Head, ...infer Tail] ? readonly [Shape<Head>, ...TupleShape<Tail>]
  : T extends readonly [...infer Init, infer Last] ? readonly [...TupleShape<Init>, Shape<Last>]
  : number extends T["length"]
    ? readonly T[number][] extends Readonly<T>
      ? readonly Shape<T[number]>[]
      : T extends readonly [(infer Head)?, ...infer Tail]
        ? readonly [{
            optionalElement: true;
            explicitUndefined: [undefined] extends readonly [Head?] ? true : false;
            value: Shape<Required<readonly [Head?]>[0]>;
            raw: Shape<(readonly [Head?])[0]>;
          }?, ...TupleShape<Tail>]
        : readonly Shape<T[number]>[]
    : { readonly [K in keyof T]: {
        optionalElement: {} extends Pick<T, K> ? true : false;
        explicitUndefined: { [P in K]: undefined } extends Pick<T, K> ? true : false;
        value: Shape<Required<T>[K]>;
        raw: Shape<T[K]>;
      } };

export type Shape<T> = 0 extends 1 & T ? { any: true }
  : unknown extends T ? T
  : T extends readonly unknown[] ? TupleShape<T>
  : T extends object ? {
      keys: keyof T;
      fields: {
        -readonly [K in keyof T]-?: {
          optional: {} extends Pick<T, K> ? true : false;
          explicitUndefined: { [P in K]: undefined } extends Pick<T, K> ? true : false;
          value: Shape<Required<T>[K]>;
          raw: Shape<T[K]>;
        };
      };
    }
  : T;

export type Exact<A, B> = [Shape<A>] extends [Shape<B>] ? ([Shape<B>] extends [Shape<A>] ? true : false) : false;
export type Check<T extends true> = T;

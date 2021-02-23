import * as pulumi from '@pulumi/pulumi';
import * as deepmerge from 'deepmerge';

export type WithRequired<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export const overwriteMerge = (_destinationArray: any[], sourceArray: any[]) => sourceArray;

export function deepMerge(v1: any, v2: any) {
    const mergeOpts = { arrayMerge: overwriteMerge };
    return pulumi.all([v1, v2]).apply(([v1, v2]) => deepmerge(v1, v2, mergeOpts));
}

export function base64Decode(value: string | undefined) {
    return Buffer.from(value || "", "base64").toString();
}
import { promises as fs} from 'fs';
import * as path from 'path';
import * as os from 'os';

import * as pulumi from '@pulumi/pulumi';
import * as deepmerge from 'deepmerge';

export type WithRequired<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export const overwriteMerge = (_destinationArray: any[], sourceArray: any[]) => sourceArray;

export function deepMerge(v1: Record<string, pulumi.Input<any>>, v2: Record<string, pulumi.Input<any>>) {
    const mergeOpts = { arrayMerge: overwriteMerge };
    return pulumi.all([v1, v2]).apply(([v1, v2]) => deepmerge(v1, v2, mergeOpts));
}

export function base64Decode(value: string | undefined) {
    return Buffer.from(value || "", "base64").toString();
}

export function base64Encode(value: string | undefined) {
    return Buffer.from(value || "").toString("base64");
}

export async function writeTmpFiles(filenames: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulumi-'));

    await Promise.all(Object.entries(filenames).
        map(([filename, content]) => fs.writeFile(path.join(dir, filename), content)))

    function exitHandler(options: any, err: any) {
        fs.rmdir(dir, {recursive: true});
    }

    process.on('exit', exitHandler.bind(null, {cleanup:true}));
    process.on('SIGINT', exitHandler.bind(null, {exit:true}));
    process.on('uncaughtException', exitHandler.bind(null, {exit:true}));

    return dir;
}

export const fromEntries = (xs: [string|number|symbol, any][]) =>
  xs.reduce((acc, [key, value]) => ({...acc, [key]: value}), {})
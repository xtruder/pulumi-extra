import * as pulumi from "@pulumi/pulumi";
import * as yaml from "yaml";

// removes kubernetes resource if it matches condition
export function removeK8SResourceCondition(condition: (obj: any) => boolean) {
  return (obj: any) => {
    if (condition(obj)) {
      obj.apiVersion = "v1";
      obj.kind = "List";
    }
  };
}

type ResourceParams = {
  namespace?: string;
  kind?: string;
  name?: string;
};

// removes kubernetes resource if it matches provided params
export function removeK8SResourceParams(
  { namespace, kind, name }: ResourceParams,
  negate?: boolean
) {
  return removeK8SResourceCondition((obj) => {
    const result =
      (namespace ? obj.metadata?.namespace === namespace : true) &&
      (kind ? obj.kind === kind : true) &&
      (name ? obj.metadata?.name === name : true);

    if (negate) {
      return !result;
    }

    return result;
  });
}

export function toYAML(obj: any): pulumi.Output<string> {
  return pulumi.all(obj).apply(yaml.stringify);
}

export function optional<T>(condition: any, value: T | T[]): T[] {
  return !!condition ? (Array.isArray(value) ? value : [value]) : [];
}

export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

export type DeepInput<T> = T extends object
  ? { [P in keyof T]?: DeepInput<T[P]> }
  : pulumi.Input<T>;

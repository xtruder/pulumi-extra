import * as pulumi from '@pulumi/pulumi';

export function check<A>(expected: A | ((T) => boolean), resource?: pulumi.Resource) {
    return function (value: any) {
        if (expected instanceof Function) {
            if(!expected(value)) {
                pulumi.log.error(`assertion error: ${JSON.stringify(value)}`, resource)
            }
            return;
        }

        if (JSON.stringify(value) !== JSON.stringify(expected)) {
            pulumi.log.error(`assertion error: ${JSON.stringify(value)} != ${JSON.stringify(expected)}`, resource)
        }
    };
}
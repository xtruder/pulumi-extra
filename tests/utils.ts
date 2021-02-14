import * as pulumi from '@pulumi/pulumi';
import * as equal from 'deep-equal';

export function check<A>(expected: A | ((T) => boolean), resource?: pulumi.Resource) {
    return function (value: any) {
        if (expected instanceof Function) {
            if(!expected(value)) {
                pulumi.log.error(`assertion error: ${JSON.stringify(value)}`, resource)
            }
            return;
        }

        if (!equal(value, expected)) {
            pulumi.log.error(`assertion error: ${JSON.stringify(value)} != ${JSON.stringify(expected)}`, resource)
        }
    };
}
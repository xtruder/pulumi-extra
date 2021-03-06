import * as tls from './tls';
import * as strimzi from './k8s/strimzi';
import * as grafanaOperator from './k8s/grafana';
import * as olm from './k8s/olm';
import * as postgresOperator from './k8s/zalando-postgres-operator';
import * as apicurioRegistry from './k8s/apicurio-registry';
import * as dockerRegistry from './k8s/docker-registry';
import * as knative from './k8s/knative';

export {
    tls,
    strimzi,
    grafanaOperator,
    olm,
    postgresOperator,
    apicurioRegistry,
    dockerRegistry,
    knative
};
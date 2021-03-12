# pulumi-extra

Pulumi extra resource and utils

## Development

### Starting kubernetes cluster

```
minikube start \
    --container-runtime docker \
    --docker-opt bip=172.18.0.1/16 \
    --extra-config=kubeadm.pod-network-cidr=172.18.0.1/16 \
    --addons="registry,metrics-server" \
    --insecure-registry registry.kube-system.svc.cluster.local:80
telepresence
```

Default configuration uses kvm2 driver, which requires kvm support.

### Running tests

```
cd tests/<test-name>
pulumi login --local
pulumi stack init <test-name>
pulumi up --yes --non-interactive
pulumi destroy
```

## License

MIT
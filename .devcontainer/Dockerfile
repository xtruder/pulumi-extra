FROM ghcr.io/xtruder/nix-devcontainer:v1

# cache /nix
VOLUME /nix

# create volume for pulumi config
RUN mkdir -p /home/${USERNAME}/.pulumi
VOLUME /home/${USERNAME}/.pulumi

# create volume for kubeconfig
RUN mkdir -p /home/${USERNAME}/.kube
VOLUME /home/${USERNAME}/.kube

# create volume for minikube state
RUN mkdir -p /home/${USERNAME}/.minikube
VOLUME /home/${USERNAME}/.minikube

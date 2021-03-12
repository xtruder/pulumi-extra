FROM xtruder/debian-nix-devcontainer:flakes

RUN sudo apt-get install -y iptables fuse3

# create volume for pulumi
RUN sudo -u user mkdir -p /home/${USERNAME}/.pulumi
VOLUME /home/${USERNAME}/.pulumi

# create volume for minikube
RUN sudo -u user mkdir -p /home/${USERNAME}/.minikube
VOLUME /home/${USERNAME}/.minikube

# create volume for pulumi
RUN sudo -u user mkdir -p /home/${USERNAME}/.kube
VOLUME /home/${USERNAME}/.kube

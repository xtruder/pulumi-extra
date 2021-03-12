{
    description = "pulumi-extra";

    inputs = {
      nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    };

    outputs = { self, nixpkgs }: let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      devShell.${system} = pkgs.mkShell {
        buildInputs = with pkgs; [
          pulumi-bin
          kubectl
          nodejs
          postgresql_12
          jq
          docker
          libvirt
          minikube
          docker-machine-kvm2
          kubernetes-helm
          (confluent-platform.overrideDerivation (p: {
            version = "6.1.0";
            src = pkgs.fetchurl {
              url = "https://packages.confluent.io/archive/6.1/confluent-community-6.1.0.tar.gz";
              sha256 = "sha256-U7Di8IxM/FUIf6XJEgphTvBNMG227DvNdxD4nwU1U1U=";
            };
          }))
          netcat
        ];

        shellHook = ''
          export PULUMI_CONFIG_PASSPHRASE=""

          if minikube docker-env > /dev/null; then
            eval "$(minikube docker-env)"
          fi
        '';
      };
    };
}
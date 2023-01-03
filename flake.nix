{
    description = "pulumi-extra";

    inputs = {
      nixpkgs.url = "github:nixos/nixpkgs/nixos-22.11";
      flake-utils.url = "github:numtide/flake-utils";
    };

    outputs = { self, nixpkgs, flake-utils }: flake-utils.lib.eachDefaultSystem (system: let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      crd2pulumi = pkgs.buildGoModule rec {
        pname = "crd2pulumi";
        version = "v1.2.3";
        src = pkgs.fetchurl {
          url = "https://github.com/pulumi/crd2pulumi/archive/refs/tags/${version}.tar.gz";
          sha256 = "sha256-SoqahJLe72IppOzUjKGxcU83FUi2u6dw+vU+gfXCHFk=";
        };
        vendorSha256 = "sha256-QnmqhXfE/999i+idAZbREMzNi62164uq5nGKb1nauwk=";
        doCheck = false;
      };

    in {
      devShells.default = pkgs.mkShell {
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
          netcat
          crd2pulumi
          qemu_kvm
        ];

        shellHook = ''
          export PULUMI_CONFIG_PASSPHRASE=""

          export MINIKUBE_DRIVER=qemu
          export MINIKUBE_QEMU_FIRMWARE_PATH=${pkgs.qemu_kvm}/share/qemu/edk2-x86_64-code.fd

          if minikube docker-env > /dev/null; then
            eval "$(minikube docker-env)"
          fi
        '';
      };
    });
}

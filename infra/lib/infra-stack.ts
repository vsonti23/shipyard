import * as cdk from "aws-cdk-lib/core"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as ecr from "aws-cdk-lib/aws-ecr"
import * as ecs from "aws-cdk-lib/aws-ecs"
import { Construct } from "constructs"

interface ShipyardStackProps extends cdk.StackProps {
  allowedHttpCidr: string
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ShipyardStackProps) {
    super(scope, id, props)

    const vpc = new ec2.Vpc(this, "ShipyardVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    })

    const cluster = new ecs.Cluster(this, "ShipyardCluster", {
      vpc,
      clusterName: "shipyard",
    })

    const securityGroup = new ec2.SecurityGroup(this, "ShipyardSecurityGroup", {
      vpc,
      description: "Network rules for Shipyard web server",
      allowAllOutbound: false,
    })

    securityGroup.addIngressRule(
      ec2.Peer.ipv4(props.allowedHttpCidr),
      ec2.Port.tcp(80),
      "Allow HTTP traffic",
    )

    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS traffic",
    )

    const ecsInstanceRole = new iam.Role(this, "ShipyardEcsInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Role for the shipyard ECS constainer instance",
    })

    ecsInstanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonEC2ContainerServiceforEC2Role",
      ),
    )

    ecsInstanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonSSMManagedInstanceCore",
      ),
    )

    const ecsUserData = ec2.UserData.forLinux()

    ecsUserData.addCommands(
      `echo "ECS_CLUSTER=${cluster.clusterName}" >> /etc/ecs/ecs.config`,
    )

    const ecsInstance = new ec2.Instance(this, "ShipyardEcsInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType("t4g.micro"),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(
        ecs.AmiHardwareType.ARM,
      ),
      securityGroup,
      role: ecsInstanceRole,
      userData: ecsUserData,
      associatePublicIpAddress: true,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      userDataCausesReplacement: true,
    })

    cdk.Tags.of(ecsInstance).add("Project", "ShipyardEcs")

    new cdk.CfnOutput(this, "EcsInstanceId", {
      value: ecsInstance.instanceId,
    })

    const instanceRole = new iam.Role(this, "ShipyardInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Role for Shipyard EC2 instance",
    })

    instanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonSSMManagedInstanceCore",
      ),
    )

    const instance = new ec2.Instance(this, "ShipyardInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType("t4g.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup,
      role: instanceRole,
      associatePublicIpAddress: true,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(10, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      userDataCausesReplacement: true,
    })

    cdk.Tags.of(instance).add("Project", "Shipyard")

    new cdk.CfnOutput(this, "InstanceId", {
      value: instance.instanceId,
    })

    new cdk.CfnOutput(this, "HealthUrl", {
      value: `http://${instance.instancePublicIp}/health`,
      description: "URL to check the health of the Shipyard server",
    })

    const repository = new ecr.Repository(this, "ShipyardRepository", {
      repositoryName: "shipyard",
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          description: "Keep the ten most recent images",
          maxImageCount: 10,
        },
      ],
    })

    repository.grantPull(instance.role)

    new cdk.CfnOutput(this, "EcrRepositoryUrl", {
      value: repository.repositoryUri,
    })

    const ecrRegistry = cdk.Fn.select(
      0,
      cdk.Fn.split("/", repository.repositoryUri),
    )

    instance.addUserData(
      "set -euo pipefail",

      "dnf install -y docker",
      "systemctl enable docker",
      "systemctl start docker",

      "mkdir -p /usr/local/lib/docker/cli-plugins",

      [
        "curl --fail --location --silent --show-error",
        "https://github.com/docker/compose/releases/download/v5.3.0/docker-compose-linux-aarch64",
        "--output /usr/local/lib/docker/cli-plugins/docker-compose",
      ].join(" "),

      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
      "docker compose version",

      `ECR_REGISTRY="${ecrRegistry}"`,
      `ECR_IMAGE="${repository.repositoryUri}:latest"`,

      'DOCKER_CONFIG_DIR="$(mktemp -d)"',
      'export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"',

      [
        "cleanup() {",
        'rm -f "$DOCKER_CONFIG_DIR/config.json";',
        'rmdir "$DOCKER_CONFIG_DIR" 2>/dev/null || true;',
        "}",
      ].join(" "),

      "trap cleanup EXIT",

      [
        `aws ecr get-login-password --region "${cdk.Aws.REGION}" |`,
        "docker login",
        "--username AWS",
        "--password-stdin",
        '"$ECR_REGISTRY"',
      ].join(" "),

      'docker pull "$ECR_IMAGE"',

      [
        "docker run",
        "--detach",
        "--name shipyard",
        "--restart unless-stopped",
        "--publish 80:3000",
        '"$ECR_IMAGE"',
      ].join(" "),
    )
  }
}

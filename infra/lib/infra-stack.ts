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
      ec2.Port.tcpRange(32768, 65535),
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

    new cdk.CfnOutput(this, "EcrRepositoryUrl", {
      value: repository.repositoryUri,
    })

    const taskDefinition = new ecs.Ec2TaskDefinition(
      this,
      "ShipyardTaskDefinition",
      {
        family: "shipyard",
        networkMode: ecs.NetworkMode.BRIDGE,
      },
    )

    const container = taskDefinition.addContainer("ShipyardContainer", {
      containerName: "shipyard",
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      cpu: 256,
      memoryReservationMiB: 256,
    })

    container.addPortMappings({
      containerPort: 3000,
      hostPort: 0,
      protocol: ecs.Protocol.TCP,
    })

    new ecs.CfnService(this, "ShipyardEcsService", {
      cluster,
      taskDefinition,
      serviceName: "shipyard",
      desiredCount: 1,
      launchType: "EC2",
      deploymentConfiguration: {
        minimumHealthyPercent: 0,
        maximumPercent: 200,
      },
    })

    new cdk.CfnOutput(this, "ECSHealthUrl", {
      value: `http://${ecsInstance.instancePublicIp}/health`,
      description: "Health URL for the ECS-managed Shipyard application",
    })
  }
}

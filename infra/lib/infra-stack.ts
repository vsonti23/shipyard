import * as cdk from "aws-cdk-lib/core"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as ecr from "aws-cdk-lib/aws-ecr"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as autoscaling from "aws-cdk-lib/aws-autoscaling"
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2"
import { Construct } from "constructs"

interface ShipyardStackProps extends cdk.StackProps {
  allowedHttpCidr: string
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ShipyardStackProps) {
    super(scope, id, props)

    const vpc = new ec2.Vpc(this, "ShipyardVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    })

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(
      this,
      "ShipyardLoadBalancerSecurityGroup",
      {
        vpc,
        description: "Networks rules for shipyard load balancer",
        allowAllOutbound: false,
      },
    )

    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.allowedHttpCidr),
      ec2.Port.tcp(80),
      "Allow HTTP traffic from the configured network",
    )

    const loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "ShipyardLoadBalancer",
      {
        vpc,
        internetFacing: true,
        securityGroup: loadBalancerSecurityGroup,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
      },
    )

    new cdk.CfnOutput(this, "LoadBalancerUrl", {
      value: `http://${loadBalancer.loadBalancerDnsName}`,
      description: "Public URL for the Shipyard load balancer",
    })

    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "ShipyardTargetGroup",
      {
        vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: 3000,
        targetType: elbv2.TargetType.INSTANCE,
        deregistrationDelay: cdk.Duration.seconds(30),
        healthCheck: {
          path: "/health",
          protocol: elbv2.Protocol.HTTP,
          healthyHttpCodes: "200",
        },
      },
    )

    const listener = loadBalancer.addListener("ShipyardHttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
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
      loadBalancerSecurityGroup,
      ec2.Port.tcpRange(32768, 65535),
      "Allow ECS task traffic from the load balancer",
    )

    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow ECS, SSM, and ECR HTTPS traffic",
    )

    loadBalancerSecurityGroup.addEgressRule(
      securityGroup,
      ec2.Port.tcpRange(32678, 65535),
      "Allow traffic to ECS tasks",
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

    const ecsAutoScalingGroup = new autoscaling.AutoScalingGroup(
      this,
      "ShipyardEcsAutoScalingGroup",
      {
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
        instanceType: new ec2.InstanceType("t4g.micro"),
        machineImage: ecs.EcsOptimizedImage.amazonLinux2023(
          ecs.AmiHardwareType.ARM,
        ),
        securityGroup,
        role: ecsInstanceRole,
        userData: ecsUserData,
        associatePublicIpAddress: true,
        requireImdsv2: true,
        minCapacity: 2,
        maxCapacity: 4,
        blockDevices: [
          {
            deviceName: "/dev/xvda",
            volume: autoscaling.BlockDeviceVolume.ebs(30, {
              volumeType: autoscaling.EbsDeviceVolumeType.GP3,
              encrypted: true,
              deleteOnTermination: true,
            }),
          },
        ],
      },
    )

    const capacityProvider = new ecs.AsgCapacityProvider(
      this,
      "ShipyardCapacityProvider",
      {
        autoScalingGroup: ecsAutoScalingGroup,
        enableManagedScaling: true,
        enableManagedDraining: true,
        enableManagedTerminationProtection: false,
        minimumScalingStepSize: 1,
        maximumScalingStepSize: 1,
        targetCapacityPercent: 100,
      },
    )

    cluster.addAsgCapacityProvider(capacityProvider)

    const ecsService = new ecs.CfnService(this, "ShipyardEcsService", {
      cluster,
      taskDefinition,
      serviceName: "shipyard",
      desiredCount: 7,
      placementStrategies: [
        {
          type: "spread",
          field: "attribute:ecs.availability-zone",
        },
        {
          type: "spread",
          field: "instanceId",
        },
      ],
      deploymentConfiguration: {
        minimumHealthyPercent: 0,
        maximumPercent: 200,
        deploymentCircuitBreaker: {
          enable: true,
          rollback: true,
        },
      },
      capacityProviderStrategy: [
        {
          capacityProvider: capacityProvider.capacityProviderName,
          weight: 1,
          base: 0,
        },
      ],
      loadBalancers: [
        {
          containerName: "shipyard",
          containerPort: 3000,
          targetGroupArn: targetGroup.targetGroupArn,
        },
      ],
    })

    ecsService.node.addDependency(capacityProvider)
    ecsService.node.addDependency(listener)

    cdk.Tags.of(ecsAutoScalingGroup).add("Project", "ShipyardEcs")

    new cdk.CfnOutput(this, "EcsAutoScalingGroupName", {
      value: ecsAutoScalingGroup.autoScalingGroupName,
    })
  }
}

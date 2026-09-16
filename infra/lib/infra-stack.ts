import * as cdk from "aws-cdk-lib/core"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as ecr from "aws-cdk-lib/aws-ecr"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling"
import * as autoscaling from "aws-cdk-lib/aws-autoscaling"
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2"
import * as wafv2 from "aws-cdk-lib/aws-wafv2"
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

    const webAcl = new wafv2.CfnWebACL(this, "ShipyardWebAcl", {
      name: "shipyard-web-acl",
      scope: "REGIONAL",
      defaultAction: {
        allow: {},
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "ShipyardWebAcl",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimitByIp",
          priority: 0,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "IP",
              limit: 100,
              evaluationWindowSec: 60,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "ShipyardRateLimitByIp",
            sampledRequestsEnabled: true,
          },
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

    new wafv2.CfnWebACLAssociation(this, "ShipyardWebAclAssociation", {
      resourceArn: loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    })

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

    const fargateTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ShipyardFargateTaskDefinition",
      {
        family: "shipyard-fargate",
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      },
    )

    const fargateContainer = fargateTaskDefinition.addContainer(
      "ShipyardFargateContainer",
      {
        containerName: "shipyard",
        image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: "shipyard",
        }),
      },
    )

    fargateContainer.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    })

    const fargateSecurityGroup = new ec2.SecurityGroup(
      this,
      "ShipyardFargateSecurityGroup",
      {
        vpc,
        description: "Network rules for Shipyard Fargate tasks",
        allowAllOutbound: false,
      },
    )

    fargateSecurityGroup.addIngressRule(
      loadBalancerSecurityGroup,
      ec2.Port.tcp(3000),
      "Allow Application traffic from load balancer",
    )

    fargateSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow traffic to Shipyard Fargate tasks",
    )

    const fargateTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "ShipyardFargateTargetGroup",
      {
        vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: 3000,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: cdk.Duration.seconds(30),
        healthCheck: {
          path: "/health",
          protocol: elbv2.Protocol.HTTP,
          healthyHttpCodes: "200",
        },
      },
    )

    const fargateService = new ecs.FargateService(
      this,
      "ShipyardFargateService",
      {
        cluster,
        serviceName: "shipyard-fargate",
        taskDefinition: fargateTaskDefinition,
        desiredCount: 1,
        assignPublicIp: true,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
        securityGroups: [fargateSecurityGroup],
        circuitBreaker: {
          rollback: true,
        },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
      },
    )

    fargateService.attachToApplicationTargetGroup(fargateTargetGroup)

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
      desiredCount: 4,
      placementStrategies: [
        {
          type: "spread",
          field: "attribute:ecs.availability-zone",
        },
        {
          type: "binpack",
          field: "memory",
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

    const taskScalingTarget = new appscaling.ScalableTarget(
      this,
      "ShipyardTaskScalingTarget",
      {
        serviceNamespace: appscaling.ServiceNamespace.ECS,
        scalableDimension: "ecs:service:DesiredCount",
        resourceId: `service/${cluster.clusterName}/shipyard`,
        minCapacity: 4,
        maxCapacity: 8,
      },
    )

    taskScalingTarget.node.addDependency(ecsService)

    taskScalingTarget.scaleToTrackMetric("ShipyardCpuScaling", {
      predefinedMetric:
        appscaling.PredefinedMetric.ECS_SERVICE_AVERAGE_CPU_UTILIZATION,
      targetValue: 50,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.minutes(5),
    })

    new cdk.CfnOutput(this, "EcsAutoScalingGroupName", {
      value: ecsAutoScalingGroup.autoScalingGroupName,
    })
  }
}

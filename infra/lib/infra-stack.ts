import * as acm from "aws-cdk-lib/aws-certificatemanager"
import * as cdk from "aws-cdk-lib/core"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecr from "aws-cdk-lib/aws-ecr"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2"
import * as wafv2 from "aws-cdk-lib/aws-wafv2"
import type { Construct } from "constructs"

interface ShipyardStackProps extends cdk.StackProps {
  allowedHttpCidr: string
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ShipyardStackProps) {
    super(scope, id, props)

    const shipyardDomainName = "shipyard.varshiksonti.dev"

    const certificate = new acm.Certificate(this, "ShipyardCertificate", {
      domainName: shipyardDomainName,
      validation: acm.CertificateValidation.fromDns(),
    })

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

    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.allowedHttpCidr),
      ec2.Port.tcp(443),
      "Allow HTTPS traffic from the configured network",
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

    const cluster = new ecs.Cluster(this, "ShipyardCluster", {
      vpc,
      clusterName: "shipyard",
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

    loadBalancerSecurityGroup.addEgressRule(
      fargateSecurityGroup,
      ec2.Port.tcp(3000),
      "Allow traffic to ECS tasks",
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

    const fargateTaskScaling = fargateService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    })

    fargateTaskScaling.scaleOnCpuUtilization("ShipyardFargateCpuScaling", {
      targetUtilizationPercent: 50,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.minutes(5),
    })

    loadBalancer.addListener("ShipyardHttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    })

    loadBalancer.addListener("ShipyardHttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: false,
      defaultAction: elbv2.ListenerAction.forward([fargateTargetGroup]),
    })
  }
}

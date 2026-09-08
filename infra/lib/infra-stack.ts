import * as cdk from "aws-cdk-lib/core"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import { Construct } from "constructs"
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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

    const securityGroup = new ec2.SecurityGroup(this, "ShipyardSecurityGroup", {
      vpc,
      description: "Network rules for Shipyard web server",
      allowAllOutbound: false,
    })

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic",
    )

    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS traffic",
    )

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

    instance.addUserData(
      "dnf install -y docker",
      "systemctl enable docker",
      "systemctl start docker",
      "docker pull ghcr.io/vsonti/shipyard:latest",
      [
        "docker run",
        "--detach",
        "--name shipyard",
        "--restart unless-stopped",
        "--publish 80:3000",
        "ghcr.io/vsonti23/shipyard:latest",
      ].join(" "),
    )
  }
}

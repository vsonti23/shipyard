import * as cdk from "aws-cdk-lib"
import * as iam from "aws-cdk-lib/aws-iam"
import * as ecr from "aws-cdk-lib/aws-ecr"
import { Construct } from "constructs"

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const githubProvider = new iam.OpenIdConnectProvider(
      this,
      "GitHubOIDCProvider",
      {
        url: "https://token.actions.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
      },
    )

    const githubDeploymentRole = new iam.Role(this, "GithubDeploymentRole", {
      assumedBy: new iam.WebIdentityPrincipal(
        githubProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub":
              "repo:vsonti23@173084278/shipyard@1359570164:ref:refs/heads/main",
          },
        },
      ),
      description:
        "Allows the shipyard main branch to deploy through Github Actions",
      maxSessionDuration: cdk.Duration.hours(1),
    })

    const repository = ecr.Repository.fromRepositoryName(
      this,
      "ShipyardRepository",
      "shipyard",
    )

    repository.grantPullPush(githubDeploymentRole)

    githubDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
        resources: ["*"],
      }),
    )

    githubDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeServices", "ecs:UpdateService"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:service/shipyard/shipyard`,
        ],
      }),
    )

    githubDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/ShipyardStack-ShipyardTaskDefinition*`,
        ],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "ecs-tasks.amazonaws.com",
          },
        },
      }),
    )

    githubDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:SendCommand"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}::document/AWS-RunShellScript`,
        ],
      }),
    )

    githubDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:SendCommand"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`,
        ],
        conditions: {
          StringEquals: {
            "ssm:resourceTag/Project": "Shipyard",
          },
        },
      }),
    )

    githubDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
        resources: ["*"],
      }),
    )

    const bootstrapRolePrefix = `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-hnb659fds`

    githubDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `${bootstrapRolePrefix}-deploy-role-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
          `${bootstrapRolePrefix}-lookup-role-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
          `${bootstrapRolePrefix}-file-publishing-role-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
          `${bootstrapRolePrefix}-image-publishing-role-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
        ],
      }),
    )

    new cdk.CfnOutput(this, "GithubDeploymentRoleArn", {
      value: githubDeploymentRole.roleArn,
    })
  }
}

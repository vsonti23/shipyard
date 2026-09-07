import * as cdk from "aws-cdk-lib"
import * as iam from "aws-cdk-lib/aws-iam"
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
              "repo:vsonti/shipyard:ref:refs/heads/main",
          },
        },
      ),
      description:
        "Allows the shipyard main branch to deploy through Github Actions",
      maxSessionDuration: cdk.Duration.hours(1),
    })

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

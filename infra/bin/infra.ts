#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core"
import { InfraStack } from "../lib/infra-stack"
import { PipelineStack } from "../lib/pipeline-stack"

const app = new cdk.App()
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
}

const allowedHttpCidr = process.env.ALLOWED_HTTP_CIDR

if (!allowedHttpCidr) {
  throw new Error("ALLOWED_HTTP_CIDR is required")
}

new PipelineStack(app, "PipelineStack", { env })
new InfraStack(app, "ShipyardStack", { env, allowedHttpCidr })

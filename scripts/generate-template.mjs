import { writeFile } from 'node:fs/promises';
import { routes, functionNames } from '../dist/src/routes.js';
let template = `# Generado por scripts/generate-template.mjs. Solo infraestructura de la tienda.
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Nexo Store - autenticacion propia en Lambda, sesiones PostgreSQL y roles IAM
Parameters:
  DatabaseSecretArn:
    Type: String
    Description: ARN del secreto con conexion PostgreSQL y clave SSH limitada al laboratorio.
  AppOrigin:
    Type: String
    Default: https://deployment-pending.invalid
    AllowedPattern: '^https://[^/]+$'
    Description: Origen HTTPS de la tienda, sin barra final. Frontend y API se publican bajo el mismo origen.
  DataBackend:
    Type: String
    Default: dynamo
    AllowedValues: [dynamo, postgres]
    Description: Almacenamiento de las Lambdas. postgres vuelve al camino anterior (secreto + túnel SSH).
Globals:
  Function:
    Runtime: nodejs24.x
    Handler: index.handler
    MemorySize: 1024
    Timeout: 28
    Environment:
      Variables:
        NODE_ENV: production
        NODE_OPTIONS: --enable-source-maps
        DATABASE_SECRET_ARN: !Ref DatabaseSecretArn
        APP_ORIGIN: !Ref AppOrigin
        TABLE_NAME: !Ref NexoTable
        DATA_BACKEND: !Ref DataBackend
Resources:
  NexoTable:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      TableName: nexo
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: PK
          AttributeType: S
        - AttributeName: SK
          AttributeType: S
        - AttributeName: GSI1PK
          AttributeType: S
        - AttributeName: GSI1SK
          AttributeType: S
        - AttributeName: GSI2PK
          AttributeType: S
        - AttributeName: GSI2SK
          AttributeType: S
      KeySchema:
        - AttributeName: PK
          KeyType: HASH
        - AttributeName: SK
          KeyType: RANGE
      GlobalSecondaryIndexes:
        - IndexName: GSI1
          KeySchema:
            - AttributeName: GSI1PK
              KeyType: HASH
            - AttributeName: GSI1SK
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
        # Catálogo activo en orden "popular" (GSI2SK = ventas invertidas + id). Solo los
        # atributos del listado: leer el catálogo entero cuesta ~5x menos que con ALL.
        - IndexName: GSI2
          KeySchema:
            - AttributeName: GSI2PK
              KeyType: HASH
            - AttributeName: GSI2SK
              KeyType: RANGE
          Projection:
            ProjectionType: INCLUDE
            NonKeyAttributes:
              [productId, name, description, createdAt, categoryId, categoryName, brandId, brandName, priceCents, availableUnits, rating, reviewCount, soldUnits, views, status]
      TimeToLiveSpecification:
        AttributeName: ttl
        Enabled: true
  GatewayLogs:
    Type: AWS::Logs::LogGroup
    Properties:
      RetentionInDays: 7
  StoreApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: lab
      DefinitionBody:
        openapi: 3.0.1
        info:
          title: Nexo Store
          version: '1.0'
        paths: {}
      DefaultRouteSettings:
        ThrottlingBurstLimit: 5
        ThrottlingRateLimit: 2
      AccessLogSettings:
        DestinationArn: !GetAtt GatewayLogs.Arn
        Format: '{"requestId":"$context.requestId","routeKey":"$context.routeKey","status":"$context.status","integrationError":"$context.integrationErrorMessage"}'
  FrontendBucket:
    Type: AWS::S3::Bucket
    Properties:
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: AES256
  FrontendAccess:
    Type: AWS::CloudFront::OriginAccessControl
    Properties:
      OriginAccessControlConfig:
        Name: !Sub \${AWS::StackName}-frontend
        OriginAccessControlOriginType: s3
        SigningBehavior: always
        SigningProtocol: sigv4
  StoreDistribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: true
        DefaultRootObject: index.html
        HttpVersion: http2
        PriceClass: PriceClass_100
        Origins:
          - Id: frontend
            DomainName: !GetAtt FrontendBucket.RegionalDomainName
            OriginAccessControlId: !Ref FrontendAccess
            S3OriginConfig:
              OriginAccessIdentity: ''
          - Id: api
            DomainName: !Sub \${StoreApi}.execute-api.\${AWS::Region}.amazonaws.com
            OriginPath: /lab
            CustomOriginConfig:
              OriginProtocolPolicy: https-only
              OriginSSLProtocols: [TLSv1.2]
        DefaultCacheBehavior:
          TargetOriginId: frontend
          ViewerProtocolPolicy: redirect-to-https
          Compress: true
          CachePolicyId: 658327ea-f89d-4fab-a63d-7e88639e58f6
        CacheBehaviors:
          - PathPattern: /api/*
            TargetOriginId: api
            ViewerProtocolPolicy: https-only
            AllowedMethods: [GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE]
            CachedMethods: [GET, HEAD]
            Compress: true
            CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad
            OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac
        ViewerCertificate:
          CloudFrontDefaultCertificate: true
  FrontendBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref FrontendBucket
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: cloudfront.amazonaws.com
            Action: s3:GetObject
            Resource: !Sub \${FrontendBucket.Arn}/*
            Condition:
              StringEquals:
                AWS:SourceArn: !Sub arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:distribution/\${StoreDistribution}
`;
const dynamoActions = (name) =>
  dynamoPolicy(name) === 'DynamoDBCrudPolicy'
    ? [
        'dynamodb:GetItem',
        'dynamodb:DeleteItem',
        'dynamodb:PutItem',
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:BatchGetItem',
        'dynamodb:DescribeTable',
        'dynamodb:ConditionCheckItem',
        'dynamodb:TransactWriteItems',
        'dynamodb:TransactGetItems',
      ]
    : [
        'dynamodb:GetItem',
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:BatchGetItem',
        'dynamodb:DescribeTable',
        'dynamodb:TransactGetItems',
      ];
const dynamoPolicy = (name) =>
  ['auth', 'update-cart', 'create-order', 'create-address'].includes(name)
    ? 'DynamoDBCrudPolicy'
    : 'DynamoDBReadPolicy';
for (const name of functionNames) {
  const logical = name
    .split('-')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
  template += `  ${logical}Logs:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /aws/lambda/\${AWS::StackName}-${name}
      RetentionInDays: 7
  ${logical}Role:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: OwnFunctionLogs
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: [logs:CreateLogStream, logs:PutLogEvents]
                Resource: !GetAtt ${logical}Logs.Arn
              - Effect: Allow
                Action: secretsmanager:GetSecretValue
                Resource: !Ref DatabaseSecretArn
        # Equivalente a la plantilla SAM ${dynamoPolicy(name)} (TableName: !Ref NexoTable).
        - PolicyName: ${dynamoPolicy(name)}
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: ${JSON.stringify(dynamoActions(name))}
                Resource:
                  - !GetAtt NexoTable.Arn
                  - !Sub \${NexoTable.Arn}/index/*
  ${logical}Function:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub \${AWS::StackName}-${name}
      CodeUri: ../../dist/functions/${name}.zip
      MemorySize: 1024
      Role: !GetAtt ${logical}Role.Arn
      LoggingConfig:
        LogFormat: JSON
        LogGroup: !Ref ${logical}Logs
      Events:
${routes
  .filter((route) => route.name === name)
  .map(
    (route, index) => `        Route${index}:
          Type: HttpApi
          Properties:
            ApiId: !Ref StoreApi
            Method: ${route.method}
            Path: ${route.path}
            PayloadFormatVersion: '2.0'
            TimeoutInMillis: 29000`,
  )
  .join('\n')}
`;
}
template += `Outputs:
  ApiUrl:
    Value: !Sub https://\${StoreApi}.execute-api.\${AWS::Region}.amazonaws.com/lab
  StoreUrl:
    Value: !Sub https://\${StoreDistribution.DomainName}
  FrontendBucketName:
    Value: !Ref FrontendBucket
  DistributionId:
    Value: !Ref StoreDistribution

`;
await writeFile('deploy/lambda/template.yaml', template);
console.log(
  `Plantilla SAM: ${functionNames.length} funciones y roles, ${routes.length} rutas. Sesiones verificadas dentro de cada Lambda. Sin deploy.`,
);

# Shortcuts. ENV=dev by default: `make plan ENV=prod`
# Your alarm email is read from terraform/owner.auto.tfvars (git-ignored):
#   echo 'alarm_email = "you@your-mail.com"' > terraform/owner.auto.tfvars
ENV ?= dev
TF = terraform -chdir=terraform

.PHONY: test tf-test security samples eval local load-test cost init plan apply outputs smoke destroy

test:            ## Python unit tests
	python3 -m pytest -q tests/unit

tf-test:         ## Terraform fmt + validate + offline plan test (no AWS needed)
	$(TF) fmt -check -recursive
	$(TF) init -backend=false -input=false
	$(TF) validate
	$(TF) test

security:        ## Static security scan of the Terraform code (pip install checkov)
	checkov --config-file .checkov.yaml

samples:         ## Regenerate the synthetic invoices in samples/
	python3 scripts/make_sample_invoices.py

eval:            ## Week-1 AI accuracy test (needs GEMINI_API_KEY)
	python3 tests/eval/run_eval.py --out eval-report.json

local:           ## Run the web app against a local fake backend on :8765
	python3 tests/e2e/fake_backend.py

load-test:       ## Load test of the local fake backend (docs/load-test.md shows the AWS run)
	python3 tests/load/load_test.py --local

cost:            ## Monthly cost estimate for 100 and 10 000 users
	python3 scripts/cost_model.py

init:            ## Select the environment's own state: make init ENV=prod
	$(TF) init -reconfigure -backend-config=envs/$(ENV).backend.hcl

plan:
	$(TF) plan -var-file=envs/$(ENV).tfvars -out=$(ENV).tfplan

apply:
	$(TF) apply $(ENV).tfplan

outputs:
	$(TF) output

smoke:           ## Check the deployed site: up, HTTPS, security headers, API protected
	python3 scripts/smoke_test.py --app-url "`$(TF) output -raw app_url`" --api-url "`$(TF) output -raw api_url`"

destroy:
	$(TF) destroy -var-file=envs/$(ENV).tfvars

# Shortcuts. ENV=dev by default: `make plan ENV=prod`
ENV ?= dev
TF = terraform -chdir=terraform

.PHONY: test tf-test samples eval init plan apply destroy outputs local

test:            ## Python unit tests
	python3 -m pytest -q tests/unit

tf-test:         ## Terraform fmt + validate + offline plan test (no AWS needed)
	$(TF) fmt -check -recursive
	$(TF) init -backend=false -input=false
	$(TF) validate
	$(TF) test

samples:         ## Regenerate the synthetic invoices in samples/
	python3 scripts/make_sample_invoices.py

eval:            ## Week-1 AI accuracy test (needs GEMINI_API_KEY)
	python3 tests/eval/run_eval.py --out eval-report.json

local:           ## Run the web app against a local fake backend on :8765
	python3 tests/e2e/fake_backend.py

init:
	$(TF) init -reconfigure -backend-config=envs/$(ENV).backend.hcl

plan:
	$(TF) plan -var-file=envs/$(ENV).tfvars -out=$(ENV).tfplan

apply:
	$(TF) apply $(ENV).tfplan

outputs:
	$(TF) output

destroy:
	$(TF) destroy -var-file=envs/$(ENV).tfvars

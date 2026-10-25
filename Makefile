.PHONY: check audit

# One local command for the whole repo; CI runs each area's half in its own workflow.
check:
	$(MAKE) -C whatsapp-reader-go check
	cd whatsapp-mcp-readonly-ts && bun run check

audit:
	$(MAKE) -C whatsapp-reader-go audit
	cd whatsapp-mcp-readonly-ts && bun run audit

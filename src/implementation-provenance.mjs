// A report's implementation field is producer-controlled metadata, not an attestation.
// Keep known published core-SDK labels useful without copying arbitrary captured text
// or terminal control sequences into public review artifacts and CI output.
const PUBLISHED_CORE_LABEL = /^@a2ui\/web_core@(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})(?: MessageProcessor)?$/;

export function safeImplementationLabel(value) {
  return typeof value === 'string' && value.length <= 80 && PUBLISHED_CORE_LABEL.test(value)
    ? value : 'unverified implementation';
}

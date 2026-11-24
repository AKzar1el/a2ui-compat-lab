import React from 'react';
import {createComponentImplementation} from '@a2ui/react/v0_9';
import {Catalog, createFunctionImplementation} from '@a2ui/web_core/v0_9';
import {basicCatalog} from '@a2ui/web_core/v0_9/basic_catalog';

export const LAB_CATALOG_ID = 'https://example.invalid/a2ui/lab-react/v0_9';

// Trusted, bundled example only. Capture data never supplies executable code.
export function createLabReactCatalog() {
  const buttonApi = basicCatalog.components.get('Button');
  const confirm = createComponentImplementation(
    {name: 'LabConfirm', schema: buttonApi.schema},
    function LabConfirm({props, buildChild}) {
      return <button type="button" data-testid="lab-custom-confirm"
        disabled={props.isValid === false} onClick={() => {
          if (props.isValid !== false) props.action?.();
        }}>
        {typeof props.child === 'string' ? buildChild(props.child) :
          props.child ? buildChild(props.child.id, props.child.basePath) : null}
      </button>;
    },
  );
  const validation = createComponentImplementation(
    {name: 'LabValidation', schema: buttonApi.schema},
    function LabValidation({props, buildChild}) {
      return <div>
        <button type="button" data-testid="lab-validation-button"
          disabled={props.isValid === false} onClick={() => {
            if (props.isValid !== false) props.action?.();
          }}>
          {typeof props.child === 'string' ? buildChild(props.child) :
            props.child ? buildChild(props.child.id, props.child.basePath) : null}
        </button>
        <output data-testid="lab-validation-message">{(props.validationErrors ?? []).join('; ')}</output>
      </div>;
    },
  );
  const check = createFunctionImplementation({
    ...basicCatalog.functions.get('required'), name: 'labCheck',
  }, ({value}) => ({valid: value === 'pass', message: 'function message', severity: 'error', code: 'LAB'}));
  return new Catalog(LAB_CATALOG_ID, '0.9',
    [...basicCatalog.components.values(), confirm, validation],
    [...basicCatalog.functions.values(), check], basicCatalog.themeSchema);
}

export const LAB_FUNCTION_CATALOG_IDS = Object.freeze({
  A: 'https://example.invalid/a2ui/lab-function-a/v0_9',
  B: 'https://example.invalid/a2ui/lab-function-b/v0_9',
});

// The same function name deliberately resolves differently in each fixed catalog.
export function createLabFunctionCatalogs() {
  const schema = basicCatalog.functions.get('required').schema;
  return Object.entries(LAB_FUNCTION_CATALOG_IDS).map(([prefix, id]) => {
    const label = createFunctionImplementation({
      name: 'labScopedLabel', returnType: 'string', schema,
    }, ({value}) => prefix + ':' + String(value));
    return new Catalog(id, '0.9', [...basicCatalog.components.values()],
      [...basicCatalog.functions.values(), label], basicCatalog.themeSchema);
  });
}

import React from 'react';
import {createComponentImplementation} from '@a2ui/react/v0_9';
import {Catalog} from '@a2ui/web_core/v0_9';
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
  return new Catalog(LAB_CATALOG_ID, '0.9',
    [...basicCatalog.components.values(), confirm],
    [...basicCatalog.functions.values()], basicCatalog.themeSchema);
}

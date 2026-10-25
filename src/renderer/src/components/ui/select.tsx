import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ComboboxOption } from './combobox';

export function Select({
	value,
	onValueChange,
	options,
	label,
	disabled,
	className,
}: {
	value: string;
	onValueChange: (value: string) => void;
	options: ComboboxOption[];
	label: string;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
			<SelectPrimitive.Trigger aria-label={label} className={cn('select-trigger', className)}>
				<SelectPrimitive.Value />
				<SelectPrimitive.Icon>
					<ChevronDown size={13} />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content className="select-content" position="popper" sideOffset={5}>
					<SelectPrimitive.ScrollUpButton className="select-scroll">
						<ChevronUp size={13} />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.Viewport>
						{options.map((option) => (
							<SelectPrimitive.Item key={option.value} value={option.value} className="select-item">
								<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
								<SelectPrimitive.ItemIndicator>
									<Check size={13} />
								</SelectPrimitive.ItemIndicator>
							</SelectPrimitive.Item>
						))}
					</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollDownButton className="select-scroll">
						<ChevronDown size={13} />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}

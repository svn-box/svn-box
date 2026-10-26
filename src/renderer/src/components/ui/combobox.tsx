import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command';
export interface ComboboxOption {
	value: string;
	label: string;
	description?: string;
}

export function Combobox({
	value,
	onValueChange,
	options,
	label,
	placeholder,
	disabled,
	className,
}: {
	value: string;
	onValueChange: (value: string) => void;
	options: ComboboxOption[];
	label: string;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const selected = options.find((option) => option.value === value);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" role="combobox" aria-expanded={open} aria-label={label} disabled={disabled} className={cn('combobox-trigger', className)}>
					<span className={cn('truncate', !selected && 'muted')}>{selected?.label ?? placeholder ?? t('combobox.choose')}</span>
					<ChevronsUpDown />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="combobox-content">
				<Command>
					<CommandInput
						placeholder={t('combobox.search', {
							label: label,
						})}
						aria-label={t('combobox.search2', {
							label: label,
						})}
					/>
					<CommandList>
						<CommandEmpty>{t('combobox.noMatches')}</CommandEmpty>
						<CommandGroup>
							{options.map((option, index) => (
								<CommandItem
									key={option.value}
									value={`${index} ${option.label}`}
									keywords={[option.value, option.description ?? '']}
									onSelect={() => {
										onValueChange(option.value);
										setOpen(false);
									}}
								>
									<Check size={13} className={option.value === value ? '' : 'invisible'} />
									<span className="min-w-0">
										<span className="block truncate">{option.label}</span>
										{option.description && <small className="block truncate muted">{option.description}</small>}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
